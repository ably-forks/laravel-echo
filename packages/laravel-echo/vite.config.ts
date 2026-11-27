import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { defineConfig, UserConfig } from "vite-plus";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"));
const require = createRequire(import.meta.url);

// Single install: @ably/pubsub-device is a dependency. ESM/CJS keep it external (the app's bundler or
// Node resolves it); the IIFE bundles its browser build, so a script-tag page needs no Ably global.
const isAblyDevice = (id: string) => id === "@ably/pubsub-device" || id.startsWith("@ably/pubsub-device/");
const optionalPeers = ["pusher-js", "socket.io-client"];
const globals = { "pusher-js": "Pusher", "socket.io-client": "io" };
const define = { __ECHO_VERSION__: JSON.stringify(pkg.version) };

// pnpm-safe: resolve the installed package (Node's "require" condition gives dist/node.js), then its browser build
// (the legacy "browser" field file, dist/index.js) for the browser-build project.
const pubsubDeviceDir = dirname(require.resolve("@ably/pubsub-device")).replace(/[\\/]dist$/, "");
// The live-sandbox suites: each creates its own Ably sandbox app (tests/ably/setup/sandbox.ts), so no keys are needed.
const sandboxFiles = [
    "tests/ably/ably-channel.test.ts",
    "tests/ably/ably-connection.test.ts",
    "tests/ably/ably-identity-switch.test.ts",
    "tests/ably/ably-presence-channel.test.ts",
    "tests/ably/ably-private-channel.test.ts",
    "tests/ably/ably-renewal-switch.test.ts",
    "tests/ably/ably-sandbox.test.ts",
    "tests/ably/ably-user-login.test.ts",
    "tests/ably/ably-user-rest-publishing.test.ts",
    "tests/ably/auth-endpoint.test.ts",
    "tests/ably/coverage-gaps.test.ts",
    "tests/ably/mau.test.ts",
    "tests/ably/token-renewal.test.ts",
];

const config: UserConfig = (() => {
    const common: Partial<UserConfig["build"]> = {
        outDir: resolve(import.meta.dirname, "dist"),
        sourcemap: true,
        minify: true,
        target: "es2022",
    };

    if (process.env.FORMAT === "iife") {
        return {
            define,
            build: {
                lib: {
                    // fork: keeps window.Echo === the Echo class (upstream builds from src/echo.ts -> namespace)
                    entry: resolve(import.meta.dirname, "src/index.iife.ts"),
                    name: "Echo",
                    formats: ["iife"],
                    fileName: () => "echo.iife.js",
                },
                rollupOptions: { external: optionalPeers, output: { globals } },
                ...common,
                emptyOutDir: false,
            },
        };
    }

    return {
        define,
        build: {
            lib: {
                entry: resolve(import.meta.dirname, "src/echo.ts"),
                formats: ["es", "cjs"],
                fileName: (format, entryName) => `${entryName}.${format === "es" ? "js" : "common.js"}`,
            },
            rollupOptions: {
                external: (id: string) => optionalPeers.includes(id) || isAblyDevice(id),
                output: { globals },
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
                        include: [
                            "tests/echo.test.ts",
                            "tests/channel/**/*.test.ts",
                            "tests/util/**/*.test.ts",
                            "tests/connector/**/*.test.ts",
                        ],
                    },
                },
                {
                    extends: true,
                    test: {
                        name: "ably",
                        environment: "node",
                        include: ["tests/ably/**/*.test.ts", "tests/parity/**/*.test.ts", "tests/export-surface.test.ts"],
                        exclude: sandboxFiles,
                    },
                },
                {
                    extends: true,
                    test: {
                        name: "sandbox",
                        environment: "node",
                        include: sandboxFiles,
                        testTimeout: 60_000,
                        hookTimeout: 60_000,
                        pool: "forks",
                        maxWorkers: 4,
                        fileParallelism: true,
                    },
                },
                {
                    // tests/ably against @ably/pubsub-device's browser build, which browser users actually ship (D-09)
                    extends: true,
                    test: {
                        name: "browser-build",
                        environment: "node",
                        include: ["tests/ably/**/*.test.ts"],
                        testTimeout: 60_000,
                        hookTimeout: 60_000,
                        pool: "forks",
                        maxWorkers: 4,
                    },
                    resolve: {
                        alias: [{ find: /^@ably\/pubsub-device$/, replacement: join(pubsubDeviceDir, "dist/index.js") }],
                    },
                },
                {
                    // smoke tests of dist/: run after the build
                    extends: true,
                    test: { name: "bundles", environment: "node", include: ["tests/bundles/**/*.test.ts"] },
                },
            ],
        },
    };
})();

export default defineConfig(config);
