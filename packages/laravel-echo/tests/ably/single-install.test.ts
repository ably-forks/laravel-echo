/**
 * Single install: Echo always uses its own @ably/pubsub-device and never reads a global `Ably` / `AblyPubSub`. When
 * such a global exists (for example the 1.0.x README's `window.Ably = require('ably')`), it logs one console.warn.
 * A user-supplied `options.client` is still used as is, and gets no warning. No network: autoConnect is false.
 */
import { FakeEmitter, makeFakeAbly } from '../parity/fake-ably';

const baseOptions = { broadcaster: 'ably', autoConnect: false, requestTokenFn: async () => ({ token: 'x' }) };
const IGNORED = /global `Ably` \/ `AblyPubSub` is ignored; Echo uses its own @ably\/pubsub-device/;

// a fresh module registry per test, so the once-per-page warning starts unset
const loadEcho = () => {
    let Echo: any;
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        Echo = require('../../src/echo').default;
    });
    return Echo;
};

let warn: jest.SpyInstance;

beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    delete (globalThis as any).Ably;
    delete (globalThis as any).AblyPubSub;
    jest.restoreAllMocks();
});

const ignoredWarnings = () => warn.mock.calls.filter(([message]) => IGNORED.test(String(message)));

describe('single install', () => {
    test('a legacy ably v1/v2 global is ignored and warned about once, across instances and reconnects', () => {
        const legacy = { Realtime: jest.fn(), Rest: jest.fn() };
        (globalThis as any).Ably = legacy;
        const Echo = loadEcho();

        const first = new Echo({ ...baseOptions });
        expect(typeof first.connector.ably.connection.on).toBe('function'); // Echo's own v3 client
        first.connect();
        const second = new Echo({ ...baseOptions });

        expect(legacy.Realtime).not.toHaveBeenCalled();
        expect(ignoredWarnings()).toHaveLength(1);
        first.disconnect();
        second.disconnect();
    });

    test('the CDN global AblyPubSub is ignored and warned about too', () => {
        const createClient = jest.fn();
        (globalThis as any).AblyPubSub = { createClient };
        const echo = new (loadEcho())({ ...baseOptions });
        expect(createClient).not.toHaveBeenCalled();
        expect(ignoredWarnings()).toHaveLength(1);
        echo.disconnect();
    });

    test('no warning without an Ably global', () => {
        const echo = new (loadEcho())({ ...baseOptions });
        expect(ignoredWarnings()).toHaveLength(0);
        echo.disconnect();
    });

    test('options.client is still used as is, and gets no warning even with an Ably global present', () => {
        (globalThis as any).Ably = { Realtime: jest.fn() };
        const client: any = { ...makeFakeAbly(), connection: new FakeEmitter(), close: jest.fn(), auth: {} };
        const echo = new (loadEcho())({ broadcaster: 'ably', client });
        expect(echo.connector.ably).toBe(client);
        expect(ignoredWarnings()).toHaveLength(0);
    });
});
