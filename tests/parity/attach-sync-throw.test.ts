/**
 * Patched _attach (beforeChannelAttach): an exception thrown synchronously by the library's own attach, after the
 * authorizer already called back (public channel or cached token), must reject attach() as in 1.0.6, not be
 * swallowed and leave attach() pending (review T18).
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
    beforeChannelAttach({ channels: { get: () => ch } }, (_c, done) => done(null));
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
