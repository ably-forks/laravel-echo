import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, UserConfig } from "vite-plus";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"));

// Single install: @ably/pubsub-device is a dependency. ESM/CJS keep it external (the app's bundler or
// Node resolves it); the IIFE bundles its browser build, so a script-tag page needs no Ably global.
const isAblyDevice = (id: string) => id === "@ably/pubsub-device" || id.startsWith("@ably/pubsub-device/");
const optionalPeers = ["pusher-js", "socket.io-client"];
const globals = { "pusher-js": "Pusher", "socket.io-client": "io" };
const define = { __ECHO_VERSION__: JSON.stringify(pkg.version) };

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
        test: { globals: true, environment: "jsdom" },
    };
})();

export default defineConfig(config);
