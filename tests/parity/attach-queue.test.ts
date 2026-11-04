/**
 * Patched _attach (beforeChannelAttach): callers queued while a channel is authorizing (review P1, T18, CodeRabbit CR-3).
 * They settle with the outcome of that authorization and ATTACH. One of them can be ably's own fire-and-forget
 * attach(): v3 presence.enter()/update() on an 'initialized' channel calls channel.attach() without a handler, so a
 * queued attach() promise must never become an unhandled rejection, while a caller that awaits it gets the error.
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

const makeClient = (
    requestTokenFn: () => Promise<any> = async () => {
        await wait(20);
        return { token: makeJwt({ 'presence:*': ['*'] }) };
    }
) => {
    const channels: Record<string, FakeRealtimeChannel> = {};
    const client: any = {
        channels: { get: (n: string) => (channels[n] = channels[n] || Object.assign(new FakeRealtimeChannel(n), { client })) },
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
        requestTokenFn,
    });
    auth.enableAuthorizeBeforeChannelAttach();
    return { client };
};

const outcome = (p: Promise<any>) => {
    const o = { state: 'pending', error: undefined as any };
    p.then(
        () => (o.state = 'resolved'),
        (e) => {
            o.state = 'rejected';
            o.error = e;
        }
    );
    return o;
};

describe('T18 / CR-3 patched _attach: callers queued while authorizing', () => {
    test('authorization succeeds, the ATTACH fails: an awaited queued attach() is rejected, a fire-and-forget one raises nothing', async () => {
        const t = trackUnhandledRejections();
        try {
            const { client } = makeClient();
            const ch: any = client.channels.get('presence:deny');
            const err = Object.assign(new Error('denied'), { code: 40160 });
            ch.failWith = err;
            const first = outcome(ch.attach()); // Echo's own attach
            ch.attach(); // what v3 presence.enter()/update() does on an 'initialized' channel: no handler
            const awaited = outcome(ch.attach()); // a user's (or ably's subscribe()) awaited attach, queued
            await wait(100);
            expect(first).toEqual({ state: 'rejected', error: err });
            expect(awaited).toEqual({ state: 'rejected', error: err });
            expect(t.rejections).toEqual([]);
            expect(ch._pendingAttachCbs).toHaveLength(0);
        } finally {
            t.stop();
        }
    });

    test('the authorization fails: queued attach() callers are rejected with its error, without unhandled rejections', async () => {
        const t = trackUnhandledRejections();
        try {
            const err = Object.assign(new Error('auth endpoint 403'), { statusCode: 403 });
            const { client } = makeClient(async () => {
                await wait(20);
                throw err;
            });
            const ch: any = client.channels.get('presence:authfail');
            const first = outcome(ch.attach());
            ch.attach(); // fire-and-forget, queued
            const awaited = outcome(ch.attach());
            await wait(100);
            expect(first.state).toBe('rejected');
            expect(awaited).toEqual({ state: 'rejected', error: first.error });
            expect(ch.authorizing).toBe(false);
            expect(t.rejections).toEqual([]);
            expect(ch._pendingAttachCbs).toHaveLength(0);
        } finally {
            t.stop();
        }
    });

    test('an attach() that is not queued is returned unchanged (its rejection is not pre-handled)', async () => {
        const { client } = makeClient();
        const ch: any = client.channels.get('presence:initiator');
        ch.failWith = Object.assign(new Error('denied'), { code: 40160 });
        const first = ch.attach();
        await expect(first).rejects.toMatchObject({ code: 40160 });
        ch.failWith = null;
        await expect(ch.attach()).resolves.toBeUndefined();
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
