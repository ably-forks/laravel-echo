/**
 * subscribe() rejections and error() listeners: forward what no state change or attach() reported, once (review T4).
 */
import { AblyChannel, AblyPresenceChannel } from '../../src/channel';
import { ECHO_OPTIONS, ablyError, makeFakeAbly, settle, stubAuth, trackUnhandledRejections } from './fake-ably';

let unhandled: ReturnType<typeof trackUnhandledRejections>;
beforeEach(() => (unhandled = trackUnhandledRejections()));
afterEach(() => {
    unhandled.stop();
    expect(unhandled.rejections).toEqual([]);
});

/** ably v3: subscribe() on a `failed` channel rejects at once with 90001 and changes no state. */
const invalidStateError = () => ablyError('Channel operation failed as channel state is failed', 90001);

describe('subscribe() errors that no state change reports are forwarded once', () => {
    test('listen() on a failed channel reports the invalid-state error', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('public:failed');
        const echoChannel = new AblyChannel(ably, 'public:failed', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        const stateErr = ablyError('denied', 40160);
        fake.transition('failed', stateErr);
        await settle();
        expect(errorListener).toHaveBeenCalledTimes(1); // the state change
        const err = invalidStateError();
        fake.subscribe.mockImplementation(() => Promise.reject(err));
        echoChannel.listen('A', () => undefined);
        await settle();
        expect(errorListener).toHaveBeenCalledTimes(2);
        expect(errorListener).toHaveBeenLastCalledWith(err);
    });

    test('a later authorization failure on an initialized channel (no state change) is reported', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('private:x');
        const echoChannel = new AblyChannel(ably, 'private:x', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        await settle();
        const err = ablyError('auth endpoint 403', 40300);
        fake.attach.mockImplementation(() => Promise.reject(err));
        echoChannel.listen('A', () => undefined);
        await settle();
        expect(fake.state).toBe('initialized');
        expect(errorListener.mock.calls).toEqual([[err]]);
    });

    test('a later authorization failure on a detached channel is reported once per attempt', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('private:y');
        const echoChannel = new AblyChannel(ably, 'private:y', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        fake.transition('detached');
        const first = ablyError('auth endpoint 403', 40300);
        fake.attach.mockImplementation(() => Promise.reject(first));
        echoChannel.listen('A', () => undefined);
        await settle();
        const second = ablyError('auth endpoint 403', 40300);
        fake.attach.mockImplementation(() => Promise.reject(second));
        echoChannel.listenToAll(() => undefined);
        await settle();
        expect(errorListener.mock.calls).toEqual([[first], [second]]);
    });
});

describe('an older state-change error does not hide a new attach attempt failure', () => {
    test('a later authorization failure with the same code and message as an earlier state change is reported', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('private:again');
        const echoChannel = new AblyChannel(ably, 'private:again', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        const earlier = ablyError('auth endpoint 403', 40300);
        fake.transition('detached', earlier); // reported by the state change
        await settle();
        const later = ablyError('auth endpoint 403', 40300); // a new attempt, same code and message, no state change
        fake.attach.mockImplementation(() => Promise.reject(later));
        echoChannel.listen('A', () => undefined);
        await settle();
        expect(errorListener).toHaveBeenCalledTimes(2);
        expect(errorListener).toHaveBeenLastCalledWith(later);
    });
});

describe('T4 still holds: one reported failure is not repeated per subscription', () => {
    test('an attach failure reported by the state change (same code and message) is not forwarded again', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('public:deny');
        const echoChannel = new AblyChannel(ably, 'public:deny', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        let reject: (e: any) => void = () => undefined;
        fake.attach.mockImplementation(() => new Promise((_, r) => (reject = r)));
        echoChannel.listen('A', () => undefined).listen('B', () => undefined).listenToAll(() => undefined);
        fake.transition('failed', ablyError('denied', 40160));
        reject(ablyError('denied', 40160)); // a distinct object with the same code and message
        await settle();
        expect(errorListener).toHaveBeenCalledTimes(1);
    });

    test('an error already reported by attach().catch is not forwarded again by subscribe()', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('presence:room');
        const err = ablyError('auth endpoint 403', 40300);
        fake.attach.mockImplementation(() => Promise.reject(err));
        const errorListener = jest.fn();
        const echoChannel = new AblyPresenceChannel(ably, 'presence:room', ECHO_OPTIONS, stubAuth);
        echoChannel.error(errorListener);
        echoChannel.here(() => undefined).listen('A', () => undefined);
        await settle();
        expect(errorListener.mock.calls).toEqual([[err]]);
    });

    test('90009 (attached without subscribe mode) is still forwarded', async () => {
        const ably = makeFakeAbly();
        const fake = ably.channels.get('public:modes');
        const echoChannel = new AblyChannel(ably, 'public:modes', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        fake.transition('attached');
        const err = ablyError('attached without the message_subscribe mode', 90009);
        fake.subscribe.mockImplementation(() => Promise.reject(err));
        echoChannel.listen('A', () => undefined);
        await settle();
        expect(errorListener.mock.calls).toEqual([[err]]);
    });
});
