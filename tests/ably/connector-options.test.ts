/**
 * AblyConnector.connect(): library resolution (R4).
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
