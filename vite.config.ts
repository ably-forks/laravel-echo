import { defineConfig } from "vite-plus";

export default defineConfig({
    lint: {
        jsPlugins: [
            { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
        ],
        options: { typeAware: true, typeCheck: true },
        rules: {
            "no-console": "warn",
            "typescript/no-floating-promises": "error",
            "typescript/no-unsafe-argument": "warn",
            "typescript/no-unsafe-assignment": "warn",
            "typescript/no-unsafe-call": "warn",
            "typescript/no-unsafe-member-access": "warn",
            "typescript/no-unsafe-return": "warn",
            "vite-plus/prefer-vite-plus-imports": "error",
        },
        overrides: [
            {
                files: ["packages/*/tests/**"],
                rules: {
                    "typescript/no-unsafe-assignment": "off",
                    "typescript/no-unsafe-call": "off",
                    "typescript/no-unsafe-member-access": "off",
                    "typescript/no-unsafe-return": "off",
                    "typescript/unbound-method": "off",
                },
            },
            {
                // Ably connector: deliberate console hints (MAU 40161/40168/40167, ignored Ably globals, identity switch)
                files: [
                    "packages/laravel-echo/src/connector/ably-connector.ts",
                    "packages/laravel-echo/src/channel/ably/**",
                ],
                rules: { "no-console": "off" },
            },
            {
                files: ["packages/react/**"],
                plugins: ["react"],
                rules: {
                    "react/exhaustive-deps": "warn",
                    "react/rules-of-hooks": "error",
                },
            },
        ],
    },
    fmt: {
        ignorePatterns: [
            ".github/**",
            "CHANGELOG.md",
            "CHANGELOG-ABLY.md",
            "UPDATING.md",
        ],
        printWidth: 80,
        sortPackageJson: false,
    },
});
