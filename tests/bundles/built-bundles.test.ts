/**
 * R15 / R26 / single install: smoke-test the *built* bundles that users ship. Requires `npm run build` first (CI runs
 * it before this suite). Runs dist/echo.iife.js in a browser-like vm context: it bundles its own @ably/pubsub-device,
 * so it needs no Ably global, and ignores one (for example the v3 CDN bundle). Checks the ESM/CJS export surface and
 * that those builds keep @ably/pubsub-device external.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const browserContext = (warn: (...args: any[]) => void = () => undefined) => {
    const noop = () => undefined;
    const sandbox: any = {
        console: { log: noop, warn, error: noop, info: noop },
        setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: { userAgent: 'jest' },
        location: { protocol: 'https:', href: 'https://app.test/', hostname: 'app.test' },
        TextEncoder, TextDecoder, URL, crypto: globalThis.crypto, fetch: globalThis.fetch, AbortController,
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

    test('IIFE alone is self-contained: no Ably global needed, none defined, no warning', () => {
        const warn = jest.fn();
        const ctx = browserContext(warn);
        vm.runInContext(iife, ctx);
        const echo = vm.runInContext(newEcho, ctx);
        expect(typeof echo.connector.ably.connection.on).toBe('function');
        expect(echo.connector.ably.options.agents['laravel-echo']).toBeDefined();
        expect(vm.runInContext('typeof Ably + typeof AblyPubSub', ctx)).toBe('undefinedundefined');
        expect(warn).not.toHaveBeenCalled();
    });

    test('IIFE + v3 CDN bundle and the old README alias (window.Ably = AblyPubSub): the globals are ignored, one warning', () => {
        const warn = jest.fn();
        const ctx = browserContext(warn);
        vm.runInContext(cdn, ctx);
        // the CDN exports are getters, so count createClient calls through a copy of the global
        vm.runInContext('var cdnCalls = 0; var cdn = AblyPubSub; window.AblyPubSub = Object.assign({}, cdn, ' +
            '{ createClient: function (o) { cdnCalls++; return cdn.createClient(o); } }); window.Ably = AblyPubSub;', ctx);
        expect(vm.runInContext('Ably.createClient !== cdn.createClient && typeof Ably.Realtime', ctx)).toBe('undefined');
        vm.runInContext(iife, ctx);
        expect(typeof vm.runInContext(newEcho, ctx).connector.ably.connection.on).toBe('function');
        vm.runInContext(newEcho, ctx);
        expect(vm.runInContext('cdnCalls', ctx)).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/is ignored; Echo uses its own @ably\/pubsub-device/);
    });

    test('IIFE bundles @ably/pubsub-device; ESM/CJS keep it external (single install)', () => {
        expect(iife).not.toMatch(/\brequire\(|^import /m);
        expect(iife).toMatch(/Ably JavaScript Library v3\./);
        expect(read('dist/echo.js')).toMatch(/^import \* as \w+ from '@ably\/pubsub-device';$/m);
        expect(read('dist/echo.common.js')).toMatch(/require\('@ably\/pubsub-device'\)/);
        expect(read('dist/echo.js')).not.toMatch(/Ably JavaScript Library/);
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
