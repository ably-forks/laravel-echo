import { resolve } from "path";
import { defineConfig, UserConfig } from "vite-plus";

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

const config: UserConfig = (() => {
    const common: Partial<UserConfig["build"]> = {
        rollupOptions: {
            external: (id: string) =>
                id === "react" || id.startsWith("react/") || isAblyExternal(id),
            output: {
                globals: {
                    react: "React",
                    "@ably/laravel-echo": "Echo",
                    "@ably/pubsub-device": "AblyPubSub",
                },
            },
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
                    name: "EchoReact",
                    formats: ["iife"],
                    fileName: () => "echo-react.iife.js",
                },
                emptyOutDir: false, // Don't empty the output directory for the second build
                ...common,
            },
        };
    }

    return {
        define: guardedEnvVariables([
            "VITE_MERCURE_HUB_URL",
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
            projects: [
                {
                    extends: true,
                    test: {
                        name: "unit",
                        environment: "jsdom",
                        include: ["tests/**/*.test.ts"],
                        exclude: ["tests/bundles/**"],
                    },
                },
                {
                    // fork: smoke tests of dist/ (ESM, .cjs and IIFE); run after the build
                    extends: true,
                    test: {
                        name: "bundles",
                        environment: "node",
                        include: ["tests/bundles/**/*.test.ts"],
                    },
                },
            ],
        },
    };
})();

export default defineConfig(config);
