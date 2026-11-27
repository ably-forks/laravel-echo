/// <reference types="node" />
/**
 * The server-render signal in the built package (fork, P-09): run after `pnpm run build`. The runes skip
 * subscribing only without `window` and without a Svelte effect context (svelte/server's render()); a browser
 * never probes, and a client runtime without `window` subscribes as upstream. Checked against dist/index.js (with
 * the real core and the Svelte client runtime it imports) and against the IIFE.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = (file: string) => join(packageDir, "dist", file);

type Built = typeof import("../../src/index");

const loadEsm = async (): Promise<Built> => {
    vi.resetModules();

    return (await import(
        /* @vite-ignore */ pathToFileURL(dist("index.js")).href
    )) as Built;
};

describe("built ESM: server-render signal (P-09)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("subscribes in a client runtime without window, as upstream", async () => {
        expect(typeof window).toBe("undefined");

        const built = await loadEsm();

        built.configureEcho({ broadcaster: "null" });

        let hook!: { channel: () => unknown };
        let status!: () => string;
        let socketId!: () => string | undefined;

        const cleanup = $effect.root(() => {
            hook = built.useEcho("orders", ".OrderShipped", () => {});
            status = built.useConnectionStatus();
            socketId = built.useSocketId();
        });

        expect(hook.channel()).not.toBeNull();
        expect(status()).toBe("connected");
        expect(socketId()).toBe("fake-socket-id");

        cleanup();
    });

    it("skips a call outside any effect without window, as during server rendering", async () => {
        const built = await loadEsm();

        built.configureEcho({ broadcaster: "null" });

        // the minified build still recognises the client runtime's effect_orphan error
        expect(
            built.useEcho("orders", ".OrderShipped", () => {}).channel(),
        ).toBeNull();
        expect(built.useConnectionStatus()()).toBe("disconnected");
        expect(built.useSocketId()()).toBeUndefined();
    });

    it("never probes in a browser: outside any effect it throws effect_orphan, as upstream", async () => {
        vi.stubGlobal("window", {});

        const built = await loadEsm();

        built.configureEcho({ broadcaster: "null" });

        expect(() => built.useConnectionStatus()).toThrow(/effect_orphan/);
    });
});

describe("IIFE: server-render signal (P-09)", () => {
    const requireFromPackage = createRequire(join(packageDir, "package.json"));

    const load = (withWindow: boolean) => {
        const noop = () => undefined;
        const sandbox: Record<string, unknown> = {
            console: { log: noop, warn: noop, error: noop, info: noop },
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            queueMicrotask,
            navigator: { userAgent: "vitest" },
            location: { protocol: "https:", href: "https://app.test/" },
            TextEncoder,
            TextDecoder,
            URL,
            crypto: globalThis.crypto,
            AbortController,
            atob,
            btoa,
            addEventListener: noop,
            removeEventListener: noop,
            document: { cookie: "", querySelector: () => null },
        };

        sandbox.window = sandbox;
        sandbox.self = sandbox;
        sandbox.globalThis = sandbox;

        const ctx = vm.createContext(sandbox);

        vm.runInContext(
            readFileSync(
                requireFromPackage.resolve("@ably/laravel-echo/iife"),
                "utf8",
            ),
            ctx,
        );
        vm.runInContext(readFileSync(dist("echo-svelte.iife.js"), "utf8"), ctx);
        vm.runInContext(
            `EchoSvelte.configureEcho({ broadcaster: "null", withoutInterceptors: true })`,
            ctx,
        );

        if (!withWindow) {
            vm.runInContext("delete globalThis.window", ctx);
        }

        return ctx;
    };

    it("skips a call outside any effect without window (the bundled runtime's effect_orphan is recognised)", () => {
        const ctx = load(false);

        expect(vm.runInContext("typeof window", ctx)).toBe("undefined");
        expect(vm.runInContext("EchoSvelte.useConnectionStatus()()", ctx)).toBe(
            "disconnected",
        );
        expect(
            vm.runInContext(
                `EchoSvelte.useEcho("orders", ".E", () => {}).channel()`,
                ctx,
            ),
        ).toBeNull();
    });

    it("never probes with window: outside any effect it throws effect_orphan, as upstream", () => {
        const ctx = load(true);

        expect(() =>
            vm.runInContext("EchoSvelte.useConnectionStatus()", ctx),
        ).toThrow(/effect_orphan/);
    });
});
