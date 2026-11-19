/**
 * error() / subscribed() listener semantics through the promise-based ably API.
 */
import { AblyChannel, AblyPresenceChannel } from '../../src/channel';
import { ECHO_OPTIONS, ablyError, makeFakeAbly, settle, stubAuth, trackUnhandledRejections } from './fake-ably';

let unhandled: ReturnType<typeof trackUnhandledRejections>;
beforeEach(() => (unhandled = trackUnhandledRejections()));
afterEach(() => unhandled.stop());

/** Public channel whose attach fails the way v3 reports it: attach() rejects AND a 'failed' state change is emitted. */
const failingPublicChannel = (configure: (echoChannel: AblyChannel) => void) => {
    const ably = makeFakeAbly();
    const fake = ably.channels.get('public:deny');
    const err = ablyError('denied');
    let rejectAttach: (e: any) => void = () => undefined;
    const pending = new Promise((_, reject) => (rejectAttach = reject));
    pending.catch(() => undefined);
    fake.attach.mockImplementation(() => pending);
    const echoChannel = new AblyChannel(ably, 'public:deny', ECHO_OPTIONS);
    configure(echoChannel);
    return {
        fake,
        err,
        fail: async () => {
            fake.transition('failed', err);
            rejectAttach(err);
            await settle();
        },
    };
};

describe('attach failure -> error() listeners', () => {
    test('baseline: error listener sees the failed state change and the attach error (2 calls, as in 1.0.6)', async () => {
        const errorListener = jest.fn();
        const { fail, err } = failingPublicChannel((c) => c.error(errorListener));
        await fail();
        expect(errorListener).toHaveBeenCalledTimes(2);
        expect(errorListener).toHaveBeenCalledWith(err);
        expect(errorListener).toHaveBeenCalledWith(expect.objectContaining({ current: 'failed', reason: err }));
    });

    test('listen()/listenToAll() do not add extra error notifications for the same attach failure', async () => {
        const errorListener = jest.fn();
        const { fail } = failingPublicChannel((c) =>
            c
                .listen('A', () => undefined)
                .listen('B', () => undefined)
                .listenToAll(() => undefined)
                .error(errorListener)
        );
        await fail();
        // 1.0.6 + ably 1.x: 2 (subscribe(event, listener) had no callback, so attach errors were not re-reported)
        expect(errorListener).toHaveBeenCalledTimes(2);
    });

    test('a throwing error() listener does not prevent the next error() listener from running', async () => {
        const second = jest.fn();
        const { fail } = failingPublicChannel((c) =>
            c
                .error(() => {
                    throw new Error('user bug');
                })
                .error(second)
        );
        await fail();
        expect(second).toHaveBeenCalledTimes(2);
    });

    test('a throwing error() listener does not cause an unhandled promise rejection', async () => {
        const { fail } = failingPublicChannel((c) =>
            c.error(() => {
                throw new Error('user bug');
            })
        );
        await fail();
        expect(unhandled.rejections).toEqual([]);
    });
});

describe('presence-channel error routing', () => {
    test('here()/joining()/leaving() do not add extra error notifications for the same attach failure', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('presence:room');
        const err = ablyError('denied');
        fake.attach.mockImplementation(() => Promise.reject(err));
        const errorListener = jest.fn();
        const echoChannel = new AblyPresenceChannel(ably, 'presence:room', ECHO_OPTIONS, stubAuth);
        echoChannel.error(errorListener);
        await settle();
        const baseline = errorListener.mock.calls.length; // attach().catch
        echoChannel
            .here(() => undefined)
            .joining(() => undefined)
            .leaving(() => undefined);
        await settle();
        expect(errorListener).toHaveBeenCalledTimes(baseline);
    });
});

describe('subscribed() listeners', () => {
    test('called once per transition into attached (not on attached -> attached)', () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('public:ok');
        const echoChannel = new AblyChannel(ably, 'public:ok', ECHO_OPTIONS);
        const s = jest.fn();
        echoChannel.subscribed(s);
        fake.transition('attaching');
        fake.transition('attached');
        fake.transition('attached');
        expect(s).toHaveBeenCalledTimes(1);
    });

    test('a throwing subscribed() listener does not prevent the next one from running', () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('public:ok');
        const echoChannel = new AblyChannel(ably, 'public:ok', ECHO_OPTIONS);
        const second = jest.fn();
        echoChannel
            .subscribed(() => {
                throw new Error('user bug');
            })
            .subscribed(second);
        fake.transition('attaching');
        fake.transition('attached');
        expect(second).toHaveBeenCalledTimes(1);
    });
});
