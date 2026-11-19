/**
 * Patched _attach (beforeChannelAttach): an exception thrown synchronously by the library's own attach, after the
 * authorizer already called back (public channel or cached token) or after an asynchronous authorization, must
 * reject attach() and the attaches queued behind it, not be swallowed and leave them pending (review T18).
 * Own file: attach.ts patches the RealtimeChannel prototype once per module instance.
 */
import { beforeChannelAttach } from '../../src/channel/ably/attach';

class FakeRealtimeChannel {
    name: string;
    state = 'initialized';
    authorizing?: boolean;
    internalAttachArgs: any[] = [];
    constructor(name: string) {
        this.name = name;
    }
    attach() {
        return new Promise((resolve, reject) => this._attach(false, null, (e, r) => (e ? reject(e) : resolve(r))));
    }
    /** the library's internal attach, which Echo wraps */
    _attach(...args: any[]) {
        this.internalAttachArgs = args;
        throw new Error('internal attach failed');
    }
}

test('T18 a synchronous throw from the internal attach rejects attach() and resets `authorizing`', async () => {
    const ch: any = new FakeRealtimeChannel('public:x');
    const client = { channels: { get: () => ch } };
    ch.client = client; // the patched _attach looks the authorizer up per client
    beforeChannelAttach(client, (_c, done) => done(null));
    let outcome = 'pending';
    ch.attach().then(
        () => (outcome = 'resolved'),
        (e) => (outcome = 'rejected: ' + e.message)
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(outcome).toBe('rejected: internal attach failed');
    expect(ch.internalAttachArgs).toHaveLength(3);
    expect(ch.authorizing).toBe(false);
});

test('T18 the same throw after an asynchronous authorization settles the initiator and the queued callers', async () => {
    const unhandled: any[] = [];
    const onUnhandled = (e: any) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
        const ch: any = new FakeRealtimeChannel('private:async');
        const client = { channels: { get: () => ch } };
        ch.client = client;
        beforeChannelAttach(client, (_c, done) => setTimeout(() => done(null), 10));
        const settledAs = (p: Promise<any>) =>
            p.then(
                () => 'resolved',
                (e) => 'rejected: ' + e.message
            );
        const initiator = settledAs(ch.attach());
        ch.attach(); // ably's fire-and-forget attach, queued
        const queued = settledAs(ch.attach());
        expect(await initiator).toBe('rejected: internal attach failed');
        expect(await queued).toBe('rejected: internal attach failed');
        await new Promise((r) => setImmediate(r));
        expect(unhandled).toEqual([]);
        expect(ch.authorizing).toBe(false);
        expect(ch._pendingAttachCbs).toHaveLength(0);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});
