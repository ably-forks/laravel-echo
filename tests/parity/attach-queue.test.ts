/**
 * Patched _attach (beforeChannelAttach): callers queued while a channel is authorizing (review T18 / P1).
 * Authorization succeeds but the ATTACH itself then fails (40160, attach timeout, DETACHED) while an ably-internal
 * fire-and-forget attach() is queued: v3 presence.enter()/update() on an 'initialized' channel calls
 * channel.attach() without a handler, so a queued caller must never be rejected.
 * Own file: attach.ts patches the RealtimeChannel prototype once per module instance.
 */
import { AblyAuth } from '../../src/channel/ably/auth';
import { makeJwt, trackUnhandledRejections } from './fake-ably';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RealtimeChannel stand-in whose internal attach is answered asynchronously, like the server's ATTACHED/ERROR. */
class FakeRealtimeChannel {
    name: string;
    state = 'initialized';
    authorizing?: boolean;
    failWith: any = null;
    constructor(name: string) {
        this.name = name;
    }
    attach() {
        if (this.state === 'attached') return Promise.resolve(null);
        return new Promise((resolve, reject) => this._attach(false, null, (e, r) => (e ? reject(e) : resolve(r))));
    }
    /** the library's internal attach, which Echo wraps */
    _attach(_force, _reason, cb) {
        this.state = 'attaching';
        setTimeout(() => {
            if (this.failWith) {
                this.state = 'failed';
                cb?.(this.failWith);
            } else {
                this.state = 'attached';
                cb?.(null);
            }
        }, 5);
    }
}

const makeClient = () => {
    const channels: Record<string, FakeRealtimeChannel> = {};
    const client: any = {
        channels: { get: (n: string) => (channels[n] = channels[n] || new FakeRealtimeChannel(n)) },
        getTimestamp: jest.fn(() => Promise.resolve(Date.now())),
        getTimestampUsingOffset: () => Date.now(),
        auth: { tokenDetails: null, authorize: jest.fn((_, o) => Promise.resolve(o.token)), clientId: 'user1' },
        connection: { on: jest.fn(), off: jest.fn() },
        connect: jest.fn(),
    };
    const connector: any = { ably: client, channels: {} };
    const auth = new AblyAuth(connector, {
        authEndpoint: 'http://localhost/broadcasting/auth',
        auth: { headers: {} },
        requestTokenFn: async () => {
            await wait(20);
            return { token: makeJwt({ 'presence:*': ['*'] }) };
        },
    });
    auth.enableAuthorizeBeforeChannelAttach();
    return { client };
};

describe('T18 patched _attach: callers queued while authorizing', () => {
    test('authorization succeeds, the ATTACH fails: a queued ably-internal attach() is not rejected', async () => {
        const t = trackUnhandledRejections();
        try {
            const { client } = makeClient();
            const ch: any = client.channels.get('presence:deny');
            ch.failWith = Object.assign(new Error('denied'), { code: 40160 });
            let first = 'pending';
            ch.attach().then(
                () => (first = 'resolved'),
                () => (first = 'rejected')
            ); // Echo's own attach (handled)
            ch.attach(); // what v3 presence.enter()/update() does on an 'initialized' channel: no handler
            await wait(100);
            expect(first).toBe('rejected');
            expect(t.rejections).toEqual([]);
            expect(ch._pendingAttachCbs).toHaveLength(1); // kept for the next attempt
        } finally {
            t.stop();
        }
    });

    test('a caller kept after a failed ATTACH resolves on the next successful attach', async () => {
        const { client } = makeClient();
        const ch: any = client.channels.get('presence:retry');
        ch.failWith = Object.assign(new Error('denied'), { code: 40160 });
        ch.attach().catch(() => undefined);
        let queued = 'pending';
        ch.attach().then(
            () => (queued = 'resolved'),
            () => (queued = 'rejected')
        );
        await wait(100);
        expect(queued).toBe('pending');
        ch.failWith = null;
        await ch.attach();
        await wait(20);
        expect(queued).toBe('resolved');
        expect(ch._pendingAttachCbs).toHaveLength(0);
    });

    test('authorization and ATTACH succeed: the queued attach resolves (P1)', async () => {
        const { client } = makeClient();
        const ch: any = client.channels.get('presence:ok');
        const first = ch.attach();
        let second = 'pending';
        ch.attach().then(
            () => (second = 'resolved'),
            () => (second = 'rejected')
        );
        await first;
        await wait(20);
        expect(second).toBe('resolved');
    });
});
