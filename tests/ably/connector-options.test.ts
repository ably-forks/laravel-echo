/**
 * AblyConnector.connect(): library resolution (R4) and legacy host-option mapping (R5).
 * No network: clients are created with autoConnect: false.
 */
import * as AblyDevice from '@ably/pubsub-device';
import Echo from '../../src/echo';

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
