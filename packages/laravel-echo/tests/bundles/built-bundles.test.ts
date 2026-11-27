import { vi, describe, test, expect } from "vite-plus/test";
/**
 * R15 / R26 / single install: smoke-test the *built* bundles that users ship. Requires `pnpm run build` first (CI runs
 * it before this suite). Runs dist/echo.iife.js in a browser-like vm context: it bundles its own @ably/pubsub-device,
 * so it needs no Ably global, and ignores one (for example the v3 CDN bundle). Checks the ESM/CJS export surface and
 * that those builds keep @ably/pubsub-device external.
 */
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as vm from 'vm';

const requireCjs = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
// pnpm-safe: resolve the installed @ably/pubsub-device (main = dist/node.js), then files inside its package directory
const pubsubDeviceDir = path.dirname(requireCjs.resolve('@ably/pubsub-device')).replace(/[\\/]dist$/, '');
const pubsubDeviceVersion: string = JSON.parse(fs.readFileSync(path.join(pubsubDeviceDir, 'package.json'), 'utf8')).version;

const browserContext = (warn: (...args: any[]) => void = () => undefined) => {
    const noop = () => undefined;
    const sandbox: any = {
        console: { log: noop, warn, error: noop, info: noop },
        setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: { userAgent: 'vitest' },
        location: { protocol: 'https:', href: 'https://app.test/', hostname: 'app.test' },
        TextEncoder, TextDecoder, URL, crypto: globalThis.crypto, fetch: globalThis.fetch, AbortController, atob, btoa,
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
    const cdn = fs.readFileSync(path.join(pubsubDeviceDir, 'dist/cdn/ably.min.js'), 'utf8');

    test('IIFE alone is self-contained: no Ably global needed, none defined, no warning', () => {
        const warn = vi.fn();
        const ctx = browserContext(warn);
        vm.runInContext(iife, ctx);
        const echo = vm.runInContext(newEcho, ctx);
        expect(typeof echo.connector.ably.connection.on).toBe('function');
        expect(echo.connector.ably.options.agents['laravel-echo']).toBeDefined();
        expect(vm.runInContext('typeof Ably + typeof AblyPubSub', ctx)).toBe('undefinedundefined');
        expect(warn).not.toHaveBeenCalled();
    });

    test('IIFE sets window.Echo to the Echo class (E-02)', () => {
        const ctx = browserContext();
        vm.runInContext(iife, ctx);
        expect(vm.runInContext('typeof window.Echo', ctx)).toBe('function');
        expect(vm.runInContext('typeof window.Echo.prototype.channel', ctx)).toBe('function');
    });

    test("window.Echo also carries upstream's IIFE namespace members, so both forms work (UC-06)", () => {
        const ctx = browserContext();
        vm.runInContext(iife, ctx);
        expect(vm.runInContext('window.Echo.default === window.Echo', ctx)).toBe(true);
        expect(vm.runInContext('typeof Echo.Channel + typeof Echo.Connector + typeof Echo.EventFormatter', ctx)).toBe(
            'functionfunctionfunction'
        );
        const options = `{ broadcaster: 'ably', withoutInterceptors: true, autoConnect: false,
            requestTokenFn: async () => ({ token: 'x.e30.y' }) }`;
        const fork = vm.runInContext(`new Echo(${options})`, ctx); // the fork's (1.x) form
        const upstream = vm.runInContext(`new Echo.default(${options})`, ctx); // upstream's form
        expect(fork.connector.ably.connection.state).toBe('initialized');
        expect(upstream.connector.ably.connection.state).toBe('initialized');
        expect(vm.runInContext('new Echo.EventFormatter("App.Events").format("OrderShipped")', ctx)).toBe(
            'App\\Events\\OrderShipped'
        );
    });

    test('IIFE + v3 CDN bundle and the old README alias (window.Ably = AblyPubSub): the globals are ignored, one warning', () => {
        const warn = vi.fn();
        const ctx = browserContext(warn);
        vm.runInContext(cdn, ctx);
        // the CDN exports are getters, so count createClient calls through a copy of the global
        vm.runInContext('var cdnCalls = 0; var cdn = AblyPubSub; window.AblyPubSub = Object.assign({}, cdn, ' +
            '{ createClient: function (o) { cdnCalls++; return cdn.createClient(o); } }); window.Ably = AblyPubSub;', ctx);
        expect(vm.runInContext('Ably.createClient !== cdn.createClient', ctx)).toBe(true); // the counting copy is in place
        vm.runInContext(iife, ctx);
        expect(typeof vm.runInContext(newEcho, ctx).connector.ably.connection.on).toBe('function');
        vm.runInContext(newEcho, ctx);
        expect(vm.runInContext('cdnCalls', ctx)).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/is ignored; Echo uses its own @ably\/pubsub-device/);
    });

    test('IIFE bundles @ably/pubsub-device; ESM/CJS keep it external (single install)', () => {
        // minify strips the SDK's license banner, so look for its version literal (minified output may use backticks)
        // and for a string only the SDK contains (its protocol-version header name)
        const sdkVersion = new RegExp(`[\`'"]${pubsubDeviceVersion.replace(/\./g, '\\.')}[\`'"]`);
        const sdkOnly = /X-Ably-Version/;
        expect(iife).not.toMatch(/\brequire\(|^import /m);
        expect(iife).toMatch(sdkVersion);
        expect(iife).toMatch(sdkOnly);
        expect(read('dist/echo.js')).not.toMatch(sdkOnly);
        expect(read('dist/echo.common.cjs')).not.toMatch(sdkOnly);
        expect(read('dist/echo.js')).toMatch(/^import \* as \w+ from ["']@ably\/pubsub-device["'];$/m);
        expect(read('dist/echo.common.cjs')).toMatch(/require\([`'"]@ably\/pubsub-device[`'"]\)/);
        expect(read('dist/echo.js')).not.toMatch(sdkVersion);
        expect(read('dist/echo.common.cjs')).not.toMatch(sdkVersion);
    });

    test('CJS bundle exports Channel at runtime (R26)', () => {
        expect(Object.keys(requireCjs(path.join(root, 'dist/echo.common.cjs'))).sort()).toEqual([
            'Channel', 'Connector', 'EventFormatter', 'default',
        ]);
    });

    test('the package entry points resolve: the require condition gets the CJS build, import the ESM build', async () => {
        // self-reference by package name, so package.json "main"/"exports" are what is tested
        expect(requireCjs.resolve('@ably/laravel-echo')).toBe(path.join(root, 'dist/echo.common.cjs'));
        const cjs = requireCjs('@ably/laravel-echo');
        expect(Object.keys(cjs).sort()).toEqual(['Channel', 'Connector', 'EventFormatter', 'default']);
        expect(typeof cjs.default).toBe('function');
        const esm = await import('@ably/laravel-echo');
        expect(Object.keys(esm).sort()).toEqual(['Channel', 'Connector', 'EventFormatter', 'default']);
        expect(esm.default).toBe((await import('../../dist/echo.js')).default);
    });

    test('ESM bundle exports Channel (R26)', () => {
        expect(read('dist/echo.js')).toMatch(/export \{[^}]*\bChannel\b[^}]*\}/);
    });
});
