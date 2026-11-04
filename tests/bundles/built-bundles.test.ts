/**
 * R15 / R4 / R26: smoke-test the *built* bundles that users ship. Requires `npm run build` first (CI runs it before
 * this suite). Runs dist/echo.iife.js together with the real @ably/pubsub-device CDN bundle in a browser-like vm
 * context, and checks the ESM/CJS export surface.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const browserContext = () => {
    const noop = () => undefined;
    const sandbox: any = {
        console: { log: noop, warn: noop, error: noop, info: noop },
        setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: { userAgent: 'jest' },
        location: { protocol: 'https:', href: 'https://app.test/', hostname: 'app.test' },
        TextEncoder, TextDecoder, crypto: globalThis.crypto, fetch: globalThis.fetch, AbortController,
        addEventListener: noop, removeEventListener: noop,
        document: { cookie: '', querySelector: () => null },
        WebSocket: function () { this.close = noop; },
        XMLHttpRequest: function () { return undefined; },
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox);
};

const newEcho = `new Echo({ broadcaster: 'ably', withoutInterceptors: true, autoConnect: false,
    requestTokenFn: async () => ({ token: 'x.e30.y' }) })`;

describe('built bundles', () => {
    const iife = read('dist/echo.iife.js');
    const cdn = read('node_modules/@ably/pubsub-device/dist/cdn/ably.min.js');

    test('IIFE + v3 CDN bundle with the README alias (window.Ably = AblyPubSub)', () => {
        const ctx = browserContext();
        vm.runInContext(cdn, ctx);
        vm.runInContext('window.Ably = AblyPubSub;', ctx);
        vm.runInContext(iife, ctx);
        const echo = vm.runInContext(newEcho, ctx);
        expect(typeof echo.connector.ably.connection.on).toBe('function');
        expect(echo.connector.ably.options.agents['laravel-echo']).toBeDefined();
    });

    test('IIFE + v3 CDN bundle without the alias: Echo finds AblyPubSub itself (R4)', () => {
        const ctx = browserContext();
        vm.runInContext(cdn, ctx);
        vm.runInContext(iife, ctx);
        expect(typeof vm.runInContext(newEcho, ctx).connector.ably.connection.on).toBe('function');
    });

    test('IIFE with no Ably library: clear error (R4)', () => {
        const ctx = browserContext();
        vm.runInContext(iife, ctx);
        expect(() => vm.runInContext(newEcho, ctx)).toThrow(/requires @ably\/pubsub-device v3/);
    });

    test('CJS bundle exports Channel at runtime (R26)', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect(Object.keys(require(path.join(root, 'dist/echo.common.js'))).sort()).toEqual([
            'Channel', 'Connector', 'EventFormatter', 'default',
        ]);
    });

    test('ESM bundle exports Channel (R26)', () => {
        expect(read('dist/echo.js')).toMatch(/export \{[^}]*\bChannel\b[^}]*\}/);
    });
});
