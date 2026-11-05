/**
 * clientId switching without network. E1 authOptionsForToken, E2 re-armable 40102 handler, E3 switch window,
 * E4 error de-dup and an MAU 40161 attach failure (no unhandled rejection).
 */
import { AblyChannel } from '../../src/channel';
import { AblyAuth } from '../../src/channel/ably/auth';
import { beginIdentitySwitch } from '../../src/channel/ably/utils';
import { ECHO_OPTIONS, ablyError, makeFakeAblyClient, settle, trackUnhandledRejections } from './fake-ably';

let unhandled: ReturnType<typeof trackUnhandledRejections>;
beforeEach(() => (unhandled = trackUnhandledRejections()));
afterEach(() => {
    jest.useRealTimers();
    unhandled.stop();
    expect(unhandled.rejections).toEqual([]);
});

const jwt = (payload: object) =>
    [{ alg: 'HS256', typ: 'JWT' }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') + '.sig';
const tokenFor = (clientId: string | null) =>
    jwt({ 'x-ably-clientId': clientId, 'x-ably-capability': '{}', iat: 1000, exp: 4600 });

const makeAuth = (client: any, echoOptions: any = {}) =>
    new AblyAuth({ options: {}, ably: client, channels: {} } as any, {
        authEndpoint: 'http://127.0.0.1:1/broadcasting/auth',
        auth: { headers: {} },
        ...echoOptions,
    });

const failedWith = (code: number) => ({ previous: 'connecting', current: 'failed', reason: ablyError('x', code) });
const SWITCH = 40102;

describe('E2: the 40102 handler is re-armed only by `connected`', () => {
    test('one connect() per failure episode', () => {
        const client = makeFakeAblyClient('user1');
        makeAuth(client).allowReconnectOnUserLogin();
        client.connection.emit('failed', failedWith(SWITCH));
        expect(client.connect).toHaveBeenCalledTimes(1);
        client.connection.emit('failed', failedWith(SWITCH)); // no `connected` in between: cannot loop
        expect(client.connect).toHaveBeenCalledTimes(1);
        client.connection.emit('connected', {});
        client.connection.emit('failed', failedWith(SWITCH));
        expect(client.connect).toHaveBeenCalledTimes(2);
    });
});

describe('E1: authOptionsForToken', () => {
    test('unset clientId -> user token: no clientId key', () => {
        const auth = makeAuth(makeFakeAblyClient(undefined));
        const options: any = auth.authOptionsForToken(tokenFor('user1'));
        expect('clientId' in options).toBe(false);
        expect(options.token).toMatchObject({ clientId: 'user1', token: tokenFor('user1') });
        expect(options.authCallback).toBe(auth.options.authCallback);
        expect(options).toMatchObject({ queryTime: true, useTokenAuth: true, echoMessages: false });
    });

    test('user -> same user: no clientId key', () => {
        const options: any = makeAuth(makeFakeAblyClient('user1')).authOptionsForToken(tokenFor('user1'));
        expect('clientId' in options).toBe(false);
        expect(options.token.clientId).toBe('user1');
    });

    test('user -> other user: clientId null', () => {
        const auth = makeAuth(makeFakeAblyClient('user1'));
        const options: any = auth.authOptionsForToken(tokenFor('user2'));
        expect(options.clientId).toBeNull();
        expect('clientId' in options).toBe(true);
        expect(options.token).toMatchObject({ clientId: 'user2', token: tokenFor('user2') });
        expect(options.authCallback).toBe(auth.options.authCallback);
    });

    test('user -> null-clientId token: clientId null', () => {
        const options: any = makeAuth(makeFakeAblyClient('user1')).authOptionsForToken(tokenFor(null));
        expect(options.clientId).toBeNull();
        expect(options.token.clientId).toBeNull();
    });
});

describe('E2: a failed state change without a reason', () => {
    test.each([
        ['an undefined reason', { previous: 'connecting', current: 'failed' }],
        ['no argument', undefined],
    ])('%s does not throw and does not connect', (_name, stateChange) => {
        const client = makeFakeAblyClient('user1');
        makeAuth(client).allowReconnectOnUserLogin();
        expect(() => client.connection.emit('failed', stateChange)).not.toThrow();
        expect(client.connection.listenerErrors).toEqual([]);
        expect(client.connect).not.toHaveBeenCalled();
    });
});

describe('E4: one error() call for a state change plus the identical attach() rejection', () => {
    test('payload is the state-change object', async () => {
        const client = makeFakeAblyClient();
        const fake = client.channels.get('public:dedup');
        let reject: (e: any) => void = () => undefined;
        fake.attach.mockImplementation(() => new Promise((_, r) => (reject = r)));
        const echoChannel = new AblyChannel(client, 'public:dedup', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        const reason = ablyError('denied', 40161);
        fake.transition('failed', reason);
        reject(reason);
        await settle();
        expect(errorListener).toHaveBeenCalledTimes(1);
        expect(errorListener.mock.calls[0][0]).toEqual({ previous: 'initialized', current: 'failed', reason, resumed: false });
    });
});

describe('an MAU 40161 attach failure with listen() raises no unhandled rejection', () => {
    test('a public channel whose attach fails with 40161 (state change and rejection) plus listen()', async () => {
        const client = makeFakeAblyClient();
        const fake = client.channels.get('public:news');
        const reason = ablyError('no capability, MAU', 40161);
        fake.attach.mockImplementation(() => Promise.reject(reason));
        const echoChannel = new AblyChannel(client, 'public:news', ECHO_OPTIONS);
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        fake.transition('failed', reason);
        echoChannel.listen('A', () => undefined).listenToAll(() => undefined);
        await settle();
        expect(errorListener).toHaveBeenCalled();
        expect(unhandled.rejections).toEqual([]);
    });
});

/** An Echo channel on `client` with an error listener. */
const listened = (client: any, name = 'public:ch') => {
    const echoChannel = new AblyChannel(client, name, ECHO_OPTIONS);
    const errorListener = jest.fn();
    echoChannel.error(errorListener);
    return { echoChannel, fake: client.channels.get(name), errorListener };
};

describe('E3: the identity-switch window', () => {
    test.each([40161, 80019, 50003])('a real failure with %d inside the window is delivered', (code) => {
        const client = makeFakeAblyClient('user1');
        const { fake, errorListener } = listened(client);
        beginIdentitySwitch(client);
        const reason = ablyError('real', code);
        fake.transition('failed', reason);
        expect(errorListener).toHaveBeenCalledTimes(1);
        expect(errorListener.mock.calls[0][0].reason).toBe(reason);
    });

    test('also when the window was opened by tryAuthorizeOnSameConnection', async () => {
        const client = makeFakeAblyClient('user1');
        const { fake, errorListener } = listened(client);
        makeAuth(client).tryAuthorizeOnSameConnection({ token: { clientId: 'user2', token: 'x' } as any });
        fake.transition('failed', ablyError('swallowed', SWITCH));
        expect(errorListener).not.toHaveBeenCalled();
        fake.transition('failed', ablyError('real', 40161));
        expect(errorListener).toHaveBeenCalledTimes(1);
    });

    test('a second 40102 on the same channel inside the window is delivered', () => {
        const client = makeFakeAblyClient('user1');
        const { fake, errorListener } = listened(client);
        beginIdentitySwitch(client);
        fake.transition('failed', ablyError('first', SWITCH));
        expect(errorListener).not.toHaveBeenCalled();
        const second = ablyError('second', SWITCH);
        fake.transition('failed', second);
        expect(errorListener).toHaveBeenCalledTimes(1);
        expect(errorListener.mock.calls[0][0].reason).toBe(second);
    });

    test('the first 40102 is swallowed per channel', () => {
        const client = makeFakeAblyClient('user1');
        const a = listened(client, 'public:a');
        const b = listened(client, 'public:b');
        beginIdentitySwitch(client);
        a.fake.transition('failed', ablyError('x', SWITCH));
        b.fake.transition('failed', ablyError('x', SWITCH));
        expect(a.errorListener).not.toHaveBeenCalled();
        expect(b.errorListener).not.toHaveBeenCalled();
    });

    test('after the 30 s timeout a 40102 is delivered', () => {
        jest.useFakeTimers();
        const client = makeFakeAblyClient('user1');
        const { fake, errorListener } = listened(client);
        beginIdentitySwitch(client);
        jest.advanceTimersByTime(29_000);
        fake.transition('failed', ablyError('inside', SWITCH));
        expect(errorListener).not.toHaveBeenCalled();
        beginIdentitySwitch(client); // a fresh window, then let it run out
        jest.advanceTimersByTime(30_000);
        fake.transition('failed', ablyError('after', SWITCH));
        expect(errorListener).toHaveBeenCalledTimes(1);
    });

    test('a 40102 outside any switch is delivered', () => {
        const client = makeFakeAblyClient('user1'); // e.g. options.client: no AblyAuth, no window
        const { fake, errorListener } = listened(client);
        const reason = ablyError('forced mismatch', SWITCH);
        fake.transition('failed', reason);
        expect(errorListener).toHaveBeenCalledTimes(1);
        expect(errorListener.mock.calls[0][0].reason).toBe(reason);
    });

    test('the authorize rejection plus the state change of one switch give 0 calls; later distinct errors 1 each', async () => {
        // the pre-attach path: the authorize() rejection goes to ably's errorCallback (not to Echo), ably then fails the
        // channel with that same 40102, so Echo sees one 40102 on the channel, which the window swallows
        const client = makeFakeAblyClient('user1');
        const { fake, errorListener } = listened(client, 'private:room');
        client.auth.authorize.mockImplementation(() => Promise.reject(ablyError('clientId mismatch', SWITCH)));
        const callback = jest.fn();
        makeAuth(client).tryAuthorizeOnSameConnection({ token: { clientId: 'user2', token: 'x' } as any }, callback);
        await settle();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][0].code).toBe(SWITCH);
        fake.transition('failed', callback.mock.calls[0][0]);
        expect(errorListener).not.toHaveBeenCalled();
        fake.transition('failed', ablyError('capability', 40161));
        expect(errorListener).toHaveBeenCalledTimes(1);
        fake.transition('detached', ablyError('timeout', 50003));
        expect(errorListener).toHaveBeenCalledTimes(2);
    });

    test('the 40160 path: the authorize rejection delivered by Echo to a channel is swallowed once', async () => {
        const client = makeFakeAblyClient('user1');
        const { errorListener, echoChannel, fake } = listened(client, 'private:room');
        client.auth.authorize.mockImplementation(() => Promise.reject(ablyError('clientId mismatch', SWITCH)));
        const auth = makeAuth(client, { requestTokenFn: async () => ({ token: tokenFor('user2') }) });
        auth.handleChannelAuthError(echoChannel);
        await settle();
        expect(client.auth.authorize).toHaveBeenCalledTimes(1);
        expect(errorListener).not.toHaveBeenCalled();
        fake.transition('failed', ablyError('capability', 40161));
        expect(errorListener).toHaveBeenCalledTimes(1);
    });

    test('the window opens for null -> user', () => {
        const client = makeFakeAblyClient(undefined);
        const { fake, errorListener } = listened(client);
        makeAuth(client).tryAuthorizeOnSameConnection({ token: { clientId: 'user1', token: 'x' } as any });
        fake.transition('failed', ablyError('x', SWITCH));
        expect(errorListener).not.toHaveBeenCalled();
    });

    test('the window does not open for a token of the same identity', () => {
        const client = makeFakeAblyClient('user1');
        const { fake, errorListener } = listened(client);
        makeAuth(client).tryAuthorizeOnSameConnection({ token: { clientId: 'user1', token: 'x' } as any });
        fake.transition('failed', ablyError('x', SWITCH));
        expect(errorListener).toHaveBeenCalledTimes(1);
    });

    test('the window does not open for a null token on an anonymous connection', () => {
        const client = makeFakeAblyClient(null);
        const { fake, errorListener } = listened(client);
        makeAuth(client).tryAuthorizeOnSameConnection({ token: { clientId: null, token: 'x' } as any });
        fake.transition('failed', ablyError('x', SWITCH));
        expect(errorListener).toHaveBeenCalledTimes(1);
    });

    test('the window is per client', () => {
        const client = makeFakeAblyClient('user1');
        const other = makeFakeAblyClient('user1');
        const mine = listened(client);
        const theirs = listened(other);
        beginIdentitySwitch(client);
        theirs.fake.transition('failed', ablyError('x', SWITCH));
        expect(theirs.errorListener).toHaveBeenCalledTimes(1);
        mine.fake.transition('failed', ablyError('x', SWITCH));
        expect(mine.errorListener).not.toHaveBeenCalled();
    });

    describe('the window closes on', () => {
        const armed = () => {
            const client = makeFakeAblyClient('user1');
            const auth = makeAuth(client);
            auth.allowReconnectOnUserLogin();
            const channel = listened(client);
            beginIdentitySwitch(client);
            return { client, auth, ...channel };
        };

        test('connected', () => {
            const { client, fake, errorListener } = armed();
            client.connection.emit('connected', {});
            fake.transition('failed', ablyError('x', SWITCH));
            expect(errorListener).toHaveBeenCalledTimes(1);
        });

        test('a non-40102 failed', () => {
            const { client, fake, errorListener } = armed();
            client.connection.emit('failed', failedWith(40161));
            fake.transition('failed', ablyError('x', SWITCH));
            expect(errorListener).toHaveBeenCalledTimes(1);
        });

        test('a 40102 failed does not close it', () => {
            const { client, fake, errorListener } = armed();
            client.connection.emit('failed', failedWith(SWITCH));
            fake.transition('failed', ablyError('x', SWITCH));
            expect(errorListener).not.toHaveBeenCalled();
        });

        test('releaseClientIdSwitchListeners()', () => {
            const { auth, client, fake, errorListener } = armed();
            auth.releaseClientIdSwitchListeners();
            expect(client.connection.events['failed']).toEqual([]);
            expect(client.connection.events['connected']).toEqual([]);
            fake.transition('failed', ablyError('x', SWITCH));
            expect(errorListener).toHaveBeenCalledTimes(1);
        });
    });
});
