import { resolve } from "path";
import { compileModule } from "svelte/compiler";
import {
    defineConfig,
    PluginOption,
    transformWithOxc,
    UserConfig,
} from "vite-plus";

const srcDir = resolve(import.meta.dirname, "src");
const testsDir = resolve(import.meta.dirname, "tests");

const svelteRunesTsPlugin = (): PluginOption => ({
    name: "svelte-runes-ts",
    enforce: "pre",
    async transform(code, id) {
        if (
            (!id.startsWith(srcDir) && !id.startsWith(testsDir)) ||
            !id.endsWith(".ts")
        ) {
            return null;
        }

        if (!/\$state|\$effect|\$derived/.test(code)) {
            return null;
        }

        try {
            const tsResult = await transformWithOxc(code, id, {
                lang: "ts",
                target: "es2020",
            });
            const result = compileModule(tsResult.code, {
                filename: id.replace(/\.ts$/, ".js"),
                generate: "client",
            });

            if (result.warnings.length > 0) {
                for (const w of result.warnings) {
                    console.warn(`[svelte runes] ${w.message}`);
                }
            }

            return {
                code: result.js.code,
                map: result.js.map,
            };
        } catch (_err) {
            return null;
        }
    },
});

/*
 * Laravel exposes its broadcasting defaults as VITE_* variables, and the consuming app's Vite
 * build statically replaces `import.meta.env.VITE_*` — so these accesses must survive our own
 * build verbatim. The guard makes non-Vite (e.g. CJS) consumers resolve to undefined instead of
 * throwing: format rendering lowers `import.meta` in CJS output, turning the guard condition
 * falsy while the guarded access is never evaluated.
 *
 * Skipped under Vitest: its worker cannot evaluate import.meta-based defines, and tests run with a
 * real import.meta.env so no replacement is needed there.
 */
const guardedEnvVariables = (names: string[]): Record<string, string> =>
    Object.fromEntries(
        process.env.VITEST
            ? []
            : names.map((name) => [
                  `import.meta.env.${name}`,
                  `(typeof import.meta.env !== 'undefined' ? import.meta.env.${name} : undefined)`,
              ]),
    );

/*
 * fork (D-03): @ably/laravel-echo is a peer dependency and @ably/pubsub-device comes with it, so no build
 * (ESM, CJS or IIFE) bundles either of them. The IIFE reads the core IIFE's global `Echo`.
 */
const isAblyExternal = (id: string): boolean =>
    ["@ably/laravel-echo", "@ably/pubsub-device"].some(
        (pkg) => id === pkg || id.startsWith(`${pkg}/`),
    );

const globals = (id: string): string => {
    if (id.startsWith("@ably/laravel-echo")) {
        return "Echo";
    }

    if (id.startsWith("@ably/pubsub-device")) {
        return "AblyPubSub";
    }

    return id === "pusher-js" ? "Pusher" : "Svelte";
};

const config: UserConfig = (() => {
    const common: Partial<UserConfig["build"]> = {
        rollupOptions: {
            external: (id) =>
                id === "svelte" ||
                id.startsWith("svelte/") ||
                id === "pusher-js" ||
                isAblyExternal(id),
            output: { globals },
        },
        outDir: resolve(import.meta.dirname, "dist"),
        sourcemap: true,
        minify: true,
        target: "es2022",
    };

    if (process.env.FORMAT === "iife") {
        return {
            build: {
                lib: {
                    entry: resolve(import.meta.dirname, "src/index.iife.ts"),
                    name: "EchoSvelte",
                    formats: ["iife"],
                    fileName: () => "echo-svelte.iife.js",
                },
                emptyOutDir: false,
                ...common,
                rollupOptions: {
                    ...common.rollupOptions,
                    // fork (V1-B): compiled runes import svelte/internal/*, which the page's global `Svelte`
                    // does not expose, so the IIFE bundles those internals and keeps only `svelte` external
                    external: (id) =>
                        id === "svelte" ||
                        id === "pusher-js" ||
                        isAblyExternal(id),
                },
            },
        };
    }

    return {
        plugins: [svelteRunesTsPlugin()],
        define: guardedEnvVariables([
            "VITE_ABLY_PUBLIC_KEY",
            "VITE_PUSHER_APP_CLUSTER",
            "VITE_PUSHER_APP_KEY",
            "VITE_PUSHER_HOST",
            "VITE_PUSHER_PORT",
            "VITE_REVERB_APP_KEY",
            "VITE_REVERB_HOST",
            "VITE_REVERB_PORT",
            "VITE_REVERB_SCHEME",
            "VITE_SOCKET_IO_HOST",
        ]),
        build: {
            lib: {
                entry: resolve(import.meta.dirname, "src/index.ts"),
                formats: ["es", "cjs"],
                fileName: (format, entryName) => {
                    // fork (F-333): .cjs, because "type": "module" makes Node load a .js file as ESM, which breaks require()
                    return `${entryName}.${format === "es" ? "js" : "common.cjs"}`;
                },
            },
            emptyOutDir: true,
            ...common,
        },
        test: {
            globals: true,
            environment: "jsdom",
        },
    };
})();

export default defineConfig(config);
