/**
 * AblyConnector.connect(): library resolution (single install), legacy host-option mapping (R5) and the
 * failed-connection re-attach latch (R3). No network: clients are created with autoConnect: false or faked.
 */
import * as AblyDevice from '@ably/pubsub-device';

// createClient is a non-configurable getter on the real module, so wrap the module to observe the options Echo passes
jest.mock('@ably/pubsub-device', () => {
    const actual = jest.requireActual('@ably/pubsub-device');
    return { ...actual, createClient: jest.fn((options) => actual.createClient(options)) };
});
import Echo from '../../src/echo';
import { AblyConnector } from '../../src/connector/ably-connector';
import { FakeEmitter, makeFakeAbly } from '../parity/fake-ably';

const baseOptions = { broadcaster: 'ably', autoConnect: false, requestTokenFn: async () => ({ token: 'x' }) };

afterEach(() => {
    delete (globalThis as any).Ably;
    delete (globalThis as any).AblyPubSub;
    jest.restoreAllMocks();
});

describe('single install: Echo uses its own @ably/pubsub-device', () => {
    beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));

    test('connects with no Ably global at all', () => {
        const echo = new Echo({ ...baseOptions });
        expect(AblyDevice.createClient).toHaveBeenCalled();
        expect(typeof echo.connector.ably.connection.on).toBe('function');
        echo.disconnect();
    });

    test('a legacy ably v1/v2 global (no createClient) is ignored', () => {
        const legacy = { Realtime: jest.fn() };
        (globalThis as any).Ably = legacy;
        (AblyDevice.createClient as jest.Mock).mockClear();
        const echo = new Echo({ ...baseOptions });
        expect(AblyDevice.createClient).toHaveBeenCalledTimes(1);
        expect(legacy.Realtime).not.toHaveBeenCalled();
        echo.disconnect();
    });

    test('a v3 global with its own createClient is not used either', () => {
        const createClient = jest.fn();
        (globalThis as any).Ably = { createClient };
        (globalThis as any).AblyPubSub = { createClient };
        const echo = new Echo({ ...baseOptions });
        expect(createClient).not.toHaveBeenCalled();
        expect(typeof echo.connector.ably.connection.on).toBe('function');
        echo.disconnect();
    });
});

describe('P4: Echo-only options are kept out of the Ably client options', () => {
    test('createClient gets every Ably option and none of the Echo-only keys; Echo keeps its own options', () => {
        const createClient = AblyDevice.createClient as jest.Mock;
        createClient.mockClear();
        const echo = new Echo({
            ...baseOptions,
            key: 'appId.keyId:secret',
            clientId: 'user-1',
            endpoint: 'nonprod:sandbox',
            disconnectedRetryTimeout: 12345,
            authEndpoint: '/custom/auth',
            csrfToken: 'csrf-1',
            bearerToken: 'bt-1',
            host: 'echo-host',
            token: 'seed-token',
            withoutInterceptors: true,
        });
        const passed = createClient.mock.calls[0][0];
        AblyConnector.ECHO_ONLY_KEYS.forEach((key) => expect(passed).not.toHaveProperty(key));
        expect([...AblyConnector.ECHO_ONLY_KEYS].sort()).toEqual([
            'auth',
            'authEndpoint',
            'bearerToken',
            'broadcaster',
            'client',
            'csrfToken',
            'host',
            'namespace',
            'requestTokenFn',
            'userAuthentication',
            'withoutInterceptors',
        ]);

        expect(passed).toMatchObject({
            key: 'appId.keyId:secret',
            clientId: 'user-1',
            endpoint: 'nonprod:sandbox',
            disconnectedRetryTimeout: 12345,
            token: 'seed-token', // an Ably option too: v3 seeds its cached token from it
            agents: { 'laravel-echo': AblyConnector.LIB_VERSION },
        });
        // Echo's token executer still reads it
        expect(echo.connector.ablyAuth.authRequestExecuter.cachedToken).toBe('seed-token');
        expect(typeof passed.authCallback).toBe('function'); // Echo's own auth options still reach the client
        const options = echo.connector.options;
        expect(options).toMatchObject({
            broadcaster: 'ably',
            authEndpoint: '/custom/auth',
            csrfToken: 'csrf-1',
            bearerToken: 'bt-1',
            host: 'echo-host',
            token: 'seed-token',
            namespace: 'App.Events',
        });
        expect(options.auth.headers).toMatchObject({ 'X-CSRF-TOKEN': 'csrf-1', Authorization: 'Bearer bt-1' });
        expect(typeof options.requestTokenFn).toBe('function');
        echo.disconnect();
    });
});

describe('R5: environment / realtimeHost / restHost are mapped to endpoint', () => {
    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    test.each([
        [{ environment: 'sandbox' }, 'nonprod:sandbox'],
        [{ environment: 'production' }, undefined],
        [{ environment: 'eu' }, 'eu'],
        [{ realtimeHost: 'rt.example.com' }, 'rt.example.com'],
        [{ restHost: 'rest.example.com' }, 'rest.example.com'],
        [{ realtimeHost: 'rt.example.com', restHost: 'rest.example.com' }, 'rt.example.com'],
        [{ realtimeHost: 'localhost' }, 'localhost'],
    ])('%j -> endpoint %s; legacy keys removed', (legacy, endpoint) => {
        const userOptions = { ...baseOptions, ...legacy };
        const echo = new Echo(userOptions);
        const options = echo.connector.options;
        expect(options.endpoint).toBe(endpoint);
        expect(options).not.toHaveProperty('environment');
        expect(options).not.toHaveProperty('realtimeHost');
        expect(options).not.toHaveProperty('restHost');
        expect(userOptions).toMatchObject(legacy); // the caller's object is not mutated
        expect(console.warn).toHaveBeenCalled();
        echo.disconnect();
    });

    test('an explicit endpoint wins over the legacy keys', () => {
        const echo = new Echo({ ...baseOptions, endpoint: 'nonprod:sandbox', environment: 'eu' });
        expect(echo.connector.options.endpoint).toBe('nonprod:sandbox');
        echo.disconnect();
    });

    test('a dotless host other than localhost warns that it is a routing-policy id', () => {
        const echo = new Echo({ ...baseOptions, realtimeHost: 'ably-proxy' });
        expect((console.warn as jest.Mock).mock.calls.flat().join(' ')).toContain('routing-policy id');
        echo.disconnect();
    });

    test('no legacy keys: no warning, no endpoint added', () => {
        const echo = new Echo({ ...baseOptions });
        expect(echo.connector.options).not.toHaveProperty('endpoint');
        expect(console.warn).not.toHaveBeenCalled();
        echo.disconnect();
    });
});

describe('E5: MAU hints only for 40161, 40168 and 40167, once per code', () => {
    const makeClient = () => {
        const connection = new FakeEmitter();
        const fake: any = { ...makeFakeAbly(), connection, close: jest.fn(), auth: {} };
        return { fake, connection };
    };
    const fail = (connection: FakeEmitter, code: number) =>
        connection.emit('failed', { current: 'failed', reason: { code, message: `failure ${code}` } });
    const logged = () => (console.error as jest.Mock).mock.calls.map(([message]) => String(message));

    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));

    // the exact texts of MAU_HINTS in src/connector/ably-connector.ts, duplicated on purpose
    const HINT_40161 =
        'Your Ably account requires an identified client on every connection (MAU billing), but this guest connected without a clientId. ' +
        'In laravel-broadcaster set ABLY_MAU_ACCOUNT=true (config broadcasting.connections.ably.mau_account) so guests receive a clientId, ' +
        'or only connect Echo for signed-in users. See "Guest users on MAU-billed Ably accounts" in the README.';
    const HINT_40168 =
        'Your Ably account is MAU-billed and only accepts the current @ably/pubsub-device (v3) SDK, but an incompatible or older SDK build connected. ' +
        'Make sure a single, up-to-date @ably/pubsub-device is installed and that no other Ably SDK creates this connection.';
    const HINT_40167 =
        'A server-side Ably client needs the server claim on its token to connect to a MAU-billed account. This is usually a server-side ' +
        'configuration issue (laravel-broadcaster / token issuing), not a browser issue.';
    const message = (code: number, hint: string) =>
        `@ably/laravel-echo: the Ably connection failed (${code}: failure ${code}). ${hint}`;

    test('40161 logs once, with the exact message and hint', () => {
        const { fake, connection } = makeClient();
        new Echo({ broadcaster: 'ably', client: fake });
        fail(connection, 40161);
        fail(connection, 40161);
        expect(logged()).toEqual([message(40161, HINT_40161)]);
    });

    test('40168 and 40167 log their exact messages and hints, in order', () => {
        const { fake, connection } = makeClient();
        new Echo({ broadcaster: 'ably', client: fake });
        fail(connection, 40168);
        fail(connection, 40167);
        expect(logged()).toEqual([message(40168, HINT_40168), message(40167, HINT_40167)]);
    });

    test('once per code: 40161 then 40168 logs two hints', () => {
        const { fake, connection } = makeClient();
        new Echo({ broadcaster: 'ably', client: fake });
        fail(connection, 40161);
        fail(connection, 40168);
        fail(connection, 40161);
        expect(logged()).toHaveLength(2);
    });

    test.each([40102, 40142, 40101, 80019, 50003])('%i logs no hint, and the next connected still re-attaches', (code) => {
        const { fake, connection } = makeClient();
        const echo = new Echo({ broadcaster: 'ably', client: fake });
        const channel = echo.channel('a') as any;
        channel.channel.state = 'failed';
        channel.channel.attach.mockClear();
        fail(connection, code);
        connection.emit('connected', { current: 'connected' });
        expect(console.error).not.toHaveBeenCalled();
        expect(channel.channel.attach).toHaveBeenCalledTimes(1);
    });

    test('regression: an earlier unrelated failure (80019) does not use up the 40161 hint', () => {
        const { fake, connection } = makeClient();
        new Echo({ broadcaster: 'ably', client: fake });
        fail(connection, 80019);
        fail(connection, 40161);
        expect(logged()).toHaveLength(1);
        expect(logged()[0]).toContain('40161');
    });
});

describe('R3: re-attach channels after the connection failed (installed from connect(), so options.client is covered)', () => {
    const makeClient = () => {
        const connection = new FakeEmitter();
        const fake: any = { ...makeFakeAbly(), connection, close: jest.fn(), auth: {} };
        return { fake, connection };
    };

    test('on the first connected after failed, re-attaches channels that are not attached/attaching, once', () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { fake, connection } = makeClient();
        const echo = new Echo({ broadcaster: 'ably', client: fake });
        const states = { a: 'failed', b: 'initialized', c: 'attached', d: 'attaching', e: 'detached' };
        Object.entries(states).forEach(([n, state]) => {
            const ch = echo.channel(n) as any;
            ch.channel.state = state;
            ch.channel.attach.mockClear();
        });
        connection.emit('failed', { current: 'failed', reason: { code: 40161, message: 'requires an identified client' } });
        connection.emit('connecting', { current: 'connecting' });
        connection.emit('connected', { current: 'connected' });
        connection.emit('connected', { current: 'connected' }); // e.g. a later reconnect: no second re-attach
        const attachCalls = Object.keys(states).map((n) => echo.connector.channels[`public:${n}`].channel.attach.mock.calls.length);
        expect(attachCalls).toEqual([1, 1, 0, 0, 1]);
        expect(console.error).toHaveBeenCalledTimes(1); // the MAU hint
        expect((console.error as jest.Mock).mock.calls[0][0]).toContain('40161');
    });

    test('a supplied client that is already failed when Echo connects re-attaches on the next connected, once', () => {
        const { fake, connection } = makeClient();
        (connection as any).state = 'failed';
        const echo = new Echo({ broadcaster: 'ably', client: fake });
        const states = { a: 'failed', b: 'initialized', c: 'attached', d: 'attaching', e: 'detached' };
        Object.entries(states).forEach(([n, state]) => {
            const ch = echo.channel(n) as any;
            ch.channel.state = state;
            ch.channel.attach.mockClear();
        });
        connection.emit('connecting', { current: 'connecting' });
        connection.emit('connected', { current: 'connected' });
        connection.emit('connected', { current: 'connected' }); // a later reconnect: no second re-attach
        const attachCalls = Object.keys(states).map((n) => echo.connector.channels[`public:${n}`].channel.attach.mock.calls.length);
        expect(attachCalls).toEqual([1, 1, 0, 0, 1]);
    });

    test('a connected without a preceding failed re-attaches nothing', () => {
        const { fake, connection } = makeClient();
        const echo = new Echo({ broadcaster: 'ably', client: fake });
        const ch = echo.channel('x') as any;
        ch.channel.state = 'detached';
        ch.channel.attach.mockClear();
        connection.emit('connected', { current: 'connected' });
        expect(ch.channel.attach).not.toHaveBeenCalled();
    });
});

describe('P3: options.client (no AblyAuth)', () => {
    test('private(), join() and leaveChannel() do not throw', () => {
        const fake: any = { ...makeFakeAbly(), connection: new FakeEmitter(), close: jest.fn(), auth: {} };
        const echo = new Echo({ broadcaster: 'ably', client: fake });
        expect(echo.connector.ablyAuth).toBeUndefined();
        expect(() => echo.private('p3')).not.toThrow();
        expect(() => echo.join('p3')).not.toThrow();
        expect(() => echo.leaveChannel('private:p3')).not.toThrow();
        expect(() => echo.leaveChannel('presence:p3')).not.toThrow();
        expect(echo.connector.channels).toEqual({});
    });
});

describe('P6: encryptedPrivate()', () => {
    test('throws a clear error for the Ably broadcaster', () => {
        const echo = new Echo({ ...baseOptions });
        expect(() => echo.encryptedPrivate('p6')).toThrow(
            new Error('Encrypted private channels are not supported with the Ably broadcaster')
        );
        expect(echo.connector.channels).toEqual({});
        echo.disconnect();
    });
});

describe('P7: connect() called again', () => {
    const makeClient = (): any => ({ ...makeFakeAbly(), connection: new FakeEmitter(), close: jest.fn(), auth: {} });

    test('leaves the Echo channels, closes the previous client, and new channels bind to the new client', () => {
        const first = makeClient();
        const second = makeClient();
        const echo = new Echo({ broadcaster: 'ably', client: first });
        const publicChannel = echo.channel('p7') as any;
        echo.private('p7');
        echo.connector.options.client = second;
        echo.connector.connect();
        expect(first.close).toHaveBeenCalledTimes(1);
        expect(second.close).not.toHaveBeenCalled();
        expect(echo.connector.channels).toEqual({});
        expect(publicChannel.channel.unsubscribe).toHaveBeenCalled();
        expect(echo.connector.ably).toBe(second);
        expect((echo.private('p7') as any).channel).toBe(second.channels.get('private:p7'));
    });

    test('the same user-supplied client is reused, not closed', () => {
        const client = makeClient();
        const echo = new Echo({ broadcaster: 'ably', client });
        echo.channel('p7');
        echo.connector.connect();
        expect(client.close).not.toHaveBeenCalled();
        expect(echo.connector.channels).toEqual({});
        expect(echo.connector.ably).toBe(client);
    });

    test('a client Echo created is closed and replaced', () => {
        const echo = new Echo({ ...baseOptions });
        const previous = echo.connector.ably;
        echo.connector.connect();
        expect(['closing', 'closed']).toContain(previous.connection.state);
        expect(echo.connector.ably).not.toBe(previous);
        expect(echo.connector.ably.connection.state).toBe('initialized');
        echo.disconnect();
    });

    test('Echo.connect() called again releases the previous connector: its channels are left and its client closed', () => {
        const echo = new Echo({ ...baseOptions });
        const previousConnector = echo.connector;
        const previous = previousConnector.ably;
        echo.channel('p7');
        echo.connect();
        expect(echo.connector).not.toBe(previousConnector);
        expect(previousConnector.channels).toEqual({});
        expect(['closing', 'closed']).toContain(previous.connection.state);
        expect(echo.connector.ably).not.toBe(previous);
        expect(echo.connector.ably.connection.state).toBe('initialized');
        expect((echo.private('p7') as any).channel).toBe(echo.connector.ably.channels.get('private:p7'));
        echo.disconnect();
    });

    test('Echo.connect() with a supplied client does not accumulate re-attach latch listeners', () => {
        const client = makeClient();
        const echo = new Echo({ broadcaster: 'ably', client });
        echo.connect();
        echo.connect();
        echo.connect();
        expect(client.close).not.toHaveBeenCalled();
        expect(client.connection.events['failed']).toHaveLength(1);
        expect(client.connection.events['connected']).toHaveLength(1);
        // the remaining pair belongs to the current connector, so recovery still works
        echo.channel('p7');
        const ch = echo.connector.channels['public:p7'].channel;
        ch.state = 'detached';
        ch.attach.mockClear();
        client.connection.emit('failed', { current: 'failed', reason: { code: 40102, message: 'mismatched' } });
        client.connection.emit('connected', { current: 'connected' });
        expect(ch.attach).toHaveBeenCalledTimes(1);
    });
});
