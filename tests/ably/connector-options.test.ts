/**
 * AblyConnector.connect(): library resolution (R4), legacy host-option mapping (R5) and the
 * failed-connection re-attach latch (R3). No network: clients are created with autoConnect: false or faked.
 */
import * as AblyDevice from '@ably/pubsub-device';
import Echo from '../../src/echo';
import { AblyConnector } from '../../src/connector/ably-connector';
import { FakeEmitter, makeFakeAbly } from '../parity/fake-ably';

const baseOptions = { broadcaster: 'ably', autoConnect: false, requestTokenFn: async () => ({ token: 'x' }) };

afterEach(() => {
    delete (globalThis as any).Ably;
    delete (globalThis as any).AblyPubSub;
    jest.restoreAllMocks();
});

describe('R4: resolving the Ably library global', () => {
    test('uses the bare Ably global when it has createClient', () => {
        (globalThis as any).Ably = AblyDevice;
        const echo = new Echo({ ...baseOptions });
        expect(typeof echo.connector.ably.connection.on).toBe('function');
        echo.disconnect();
    });

    test('falls back to the CDN global AblyPubSub, even when a legacy Ably global shadows it', () => {
        (globalThis as any).Ably = { Realtime: jest.fn() };
        (globalThis as any).AblyPubSub = AblyDevice;
        const echo = new Echo({ ...baseOptions });
        expect(typeof echo.connector.ably.connection.on).toBe('function');
        echo.disconnect();
    });

    test('a legacy ably global alone gives a clear error instead of "createClient is not a function"', () => {
        (globalThis as any).Ably = { Realtime: jest.fn() };
        expect(() => new Echo({ ...baseOptions })).toThrow(/requires @ably\/pubsub-device v3.*legacy `ably` package/);
    });

    test('no global at all gives the same clear error', () => {
        expect(() => new Echo({ ...baseOptions })).toThrow(/requires @ably\/pubsub-device v3/);
    });
});

describe('P4: Echo-only options are kept out of the Ably client options', () => {
    test('createClient gets every Ably option and none of the Echo-only keys; Echo keeps its own options', () => {
        const createClient = jest.fn((options) => AblyDevice.createClient(options));
        (globalThis as any).Ably = { ...AblyDevice, createClient };
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
            'token',
            'userAuthentication',
            'withoutInterceptors',
        ]);

        expect(passed).toMatchObject({
            key: 'appId.keyId:secret',
            clientId: 'user-1',
            endpoint: 'nonprod:sandbox',
            disconnectedRetryTimeout: 12345,
            agents: { 'laravel-echo': AblyConnector.LIB_VERSION },
        });
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
        (globalThis as any).Ably = AblyDevice;
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
        connection.emit('failed', { current: 'failed', reason: { code: 40330, message: 'clientId required' } });
        connection.emit('connecting', { current: 'connecting' });
        connection.emit('connected', { current: 'connected' });
        connection.emit('connected', { current: 'connected' }); // e.g. a later reconnect: no second re-attach
        const attachCalls = Object.keys(states).map((n) => echo.connector.channels[`public:${n}`].channel.attach.mock.calls.length);
        expect(attachCalls).toEqual([1, 1, 0, 0, 1]);
        expect(console.error).not.toHaveBeenCalled(); // Echo does not log connection failures itself
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
        (globalThis as any).Ably = AblyDevice;
        const echo = new Echo({ ...baseOptions });
        expect(() => echo.encryptedPrivate('p6')).toThrow(
            new Error('Encrypted private channels are not supported with the Ably broadcaster')
        );
        expect(echo.connector.channels).toEqual({});
        echo.disconnect();
    });
});
