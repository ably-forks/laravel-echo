/// <reference types="node" />
/**
 * Smoke tests of the built package (fork): run after `pnpm run build` (CI builds first). Checks the export surface
 * of the ESM, CJS (.cjs, F-333) and IIFE builds (the IIFE exports the same hooks, P-06, and uses the core IIFE's
 * global Echo), that no build bundles the core or the Ably SDK (D-03), and that the env reads are guarded (F-080).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { describe, expect, it } from "vite-plus/test";

const FRAMEWORK = "react";
const IIFE_NAME = "EchoReact";
const FRAMEWORK_GLOBAL = "React";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = (file: string) => join(packageDir, "dist", file);
const read = (file: string) => readFileSync(dist(file), "utf8");
const requireFromPackage = createRequire(join(packageDir, "package.json"));
const pkg = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
) as {
    name: string;
    main: string;
    exports: Record<string, string | Record<string, string>>;
};

const runtimeExports = [
    "configureEcho",
    "echo",
    "echoIsConfigured",
    "useChannel",
    "useConnectionStatus",
    "useEcho",
    "useEchoModel",
    "useEchoNotification",
    "useEchoPresence",
    "useEchoPublic",
    "usePresenceChannel",
    "usePublicChannel",
    "useSocketId",
];

const browserContext = () => {
    const noop = () => undefined;
    const sandbox: Record<string, unknown> = {
        console: { log: noop, warn: noop, error: noop, info: noop },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        navigator: { userAgent: "vitest" },
        location: {
            protocol: "https:",
            href: "https://app.test/",
            hostname: "app.test",
        },
        TextEncoder,
        TextDecoder,
        URL,
        crypto: globalThis.crypto,
        fetch: globalThis.fetch,
        AbortController,
        atob,
        btoa,
        addEventListener: noop,
        removeEventListener: noop,
        document: { cookie: "", querySelector: () => null },
        WebSocket: function (this: { close: () => void }) {
            this.close = noop;
        },
        XMLHttpRequest: function () {
            return undefined;
        },
        // a stand-in for the framework's global: the hooks are not called here
        [FRAMEWORK_GLOBAL]: {},
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    return vm.createContext(sandbox);
};

// the core's IIFE (window.Echo = the class, E-02), then this package's IIFE, as a page loads them
const loadIifes = (prepare: (ctx: vm.Context) => void = () => undefined) => {
    const ctx = browserContext();

    vm.runInContext(
        readFileSync(
            requireFromPackage.resolve("@ably/laravel-echo/iife"),
            "utf8",
        ),
        ctx,
    );
    prepare(ctx);
    vm.runInContext(read(`echo-${FRAMEWORK}.iife.js`), ctx);

    return ctx;
};

describe("built package", () => {
    it("ESM exports the hooks and the config helpers", async () => {
        const esm = (await import(
            pathToFileURL(dist("index.js")).href
        )) as Record<string, unknown>;

        expect(Object.keys(esm).sort()).toEqual(runtimeExports);
    });

    it("require() loads the .cjs build through the package's exports (F-333)", () => {
        const resolved = requireFromPackage.resolve(pkg.name);

        expect(resolved).toBe(dist("index.common.cjs"));

        const cjs = requireFromPackage(pkg.name) as Record<string, unknown>;

        expect(Object.keys(cjs).sort()).toEqual(runtimeExports);
    });

    it("keeps upstream's main and react-native entries on index.common.js, a copy of the .cjs build", () => {
        const root = pkg.exports["."] as Record<string, string>;
        const entries = {
            main: pkg.main,
            "react-native": root["react-native"],
            require: root.require,
            import: root.import,
            types: root.types,
        };

        expect(entries).toEqual({
            main: "dist/index.common.js",
            "react-native": "./dist/index.common.js",
            require: "./dist/index.common.cjs",
            import: "./dist/index.js",
            types: "./dist/index.d.ts",
        });

        for (const entry of Object.values(entries)) {
            expect(existsSync(join(packageDir, entry))).toBe(true);
        }

        expect(readFileSync(dist("index.common.js"))).toEqual(
            readFileSync(dist("index.common.cjs")),
        );
    });

    it("the CJS build evaluates the env defaults without import.meta (F-080)", () => {
        const cjs = requireFromPackage(dist("index.common.cjs")) as {
            configureEcho: (options: Record<string, unknown>) => void;
            echoIsConfigured: () => boolean;
        };

        // configureEcho() evaluates every driver's defaults, VITE_MERCURE_HUB_URL included
        expect(() =>
            cjs.configureEcho({ broadcaster: "mercure" }),
        ).not.toThrow();
        expect(() => cjs.configureEcho({})).not.toThrow();
        expect(cjs.echoIsConfigured()).toBe(true);
    });

    it("guards every VITE_* read in the ESM build, Mercure's included (F-080)", () => {
        const esm = read("index.js");
        const reads = [...esm.matchAll(/import\.meta\.env\.(VITE_\w+)/g)].map(
            (m) => m[1],
        );
        const guarded = [
            ...esm.matchAll(
                /import\.meta\.env\s*===\s*void 0\s*\?\s*void 0\s*:\s*import\.meta\.env\.(VITE_\w+)/g,
            ),
        ].map((m) => m[1]);

        expect(reads).toContain("VITE_MERCURE_HUB_URL");
        expect(reads).not.toContain("VITE_ABLY_PUBLIC_KEY");
        expect(guarded).toEqual(reads);
    });

    it("keeps @ably/laravel-echo and @ably/pubsub-device external in every build (D-03)", () => {
        expect(read("index.js")).toMatch(/from\s*["']@ably\/laravel-echo["']/);
        expect(read("index.common.cjs")).toMatch(
            /require\(["']@ably\/laravel-echo["']\)/,
        );

        const builds = readdirSync(join(packageDir, "dist")).filter((file) =>
            /\.(c?js)$/.test(file),
        );

        expect(builds.sort()).toEqual([
            `echo-${FRAMEWORK}.iife.js`,
            "index.common.cjs",
            "index.common.js",
            "index.js",
        ]);

        for (const file of builds) {
            const code = read(file);

            // strings that survive minification of the Ably SDK or the core
            expect(code).not.toMatch(
                /XMLHttpRequest|realtime\.ably|ECHO_ONLY_KEYS|requestTokenFn/,
            );
            expect(code).not.toMatch(/["']pusher-js["']/);
        }
    });

    it("the IIFE exports the same hooks as the ESM build (P-06)", () => {
        const ctx = loadIifes();

        expect(
            Object.keys(vm.runInContext(IIFE_NAME, ctx) as object).sort(),
        ).toEqual(runtimeExports);
    });

    it("the IIFE uses the core IIFE's global Echo class", () => {
        const ctx = loadIifes();

        vm.runInContext(
            `${IIFE_NAME}.configureEcho({ broadcaster: "null", withoutInterceptors: true })`,
            ctx,
        );

        expect(
            vm.runInContext(`${IIFE_NAME}.echo() instanceof window.Echo`, ctx),
        ).toBe(true);
        expect(
            vm.runInContext(`${IIFE_NAME}.echo().connectionStatus()`, ctx),
        ).toBe("connected");
    });

    it("the IIFE resolves the default import to Echo itself, not Echo.default", () => {
        // without the UC-06 namespace statics, only the class itself can satisfy the import
        const ctx = loadIifes((context) =>
            vm.runInContext("delete window.Echo.default", context),
        );

        expect(vm.runInContext("window.Echo.default", ctx)).toBeUndefined();

        vm.runInContext(
            `${IIFE_NAME}.configureEcho({ broadcaster: "null", withoutInterceptors: true })`,
            ctx,
        );

        expect(
            vm.runInContext(`${IIFE_NAME}.echo() instanceof window.Echo`, ctx),
        ).toBe(true);
    });

    it("the IIFE defaults to the native Ably connector without a Pusher global (P-02, P-07)", () => {
        const ctx = loadIifes();

        vm.runInContext(
            `${IIFE_NAME}.configureEcho({ withoutInterceptors: true, autoConnect: false,
                requestTokenFn: async () => ({ token: "x.e30.y" }) })`,
            ctx,
        );

        expect(vm.runInContext("typeof window.Pusher", ctx)).toBe("undefined");
        expect(
            vm.runInContext(`${IIFE_NAME}.echo().options.broadcaster`, ctx),
        ).toBe("ably");
        expect(
            vm.runInContext(
                `${IIFE_NAME}.echo().connector.ably.connection.state`,
                ctx,
            ),
        ).toBe("initialized");
    });
});
