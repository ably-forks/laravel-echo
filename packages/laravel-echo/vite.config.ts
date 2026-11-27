import { readFileSync } from "node:fs";
import { resolve } from "path";
import { defineConfig, UserConfig } from "vite-plus";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"));
const define = { __ECHO_VERSION__: JSON.stringify(pkg.version) };

const config: UserConfig = (() => {
    const common: Partial<UserConfig["build"]> = {
        rollupOptions: {
            external: ["pusher-js", "socket.io-client"],
            output: {
                globals: {
                    "pusher-js": "Pusher",
                    "socket.io-client": "io",
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
            define,
            build: {
                lib: {
                    entry: resolve(import.meta.dirname, "src/echo.ts"),
                    name: "Echo",
                    formats: ["iife"],
                    fileName: () => "echo.iife.js",
                },
                ...common,
                emptyOutDir: false, // Don't empty the output directory for the second build
            },
        };
    }

    return {
        define,
        build: {
            lib: {
                entry: resolve(import.meta.dirname, "src/echo.ts"),
                formats: ["es", "cjs"],
                fileName: (format, entryName) => {
                    return `${entryName}.${format === "es" ? "js" : "common.js"}`;
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
