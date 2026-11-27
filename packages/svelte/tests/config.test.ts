import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

describe("echo helper", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("throws error when Echo is not configured", async () => {
        const { echo } = await import("../src/config");

        expect(() => echo()).toThrow("Echo has not been configured");
    });

    it("creates Echo instance with proper configuration", async () => {
        const { configureEcho, echo } = await import("../src/config");

        configureEcho({
            broadcaster: "null",
        });

        expect(echo()).toBeDefined();
        expect(echo().options.broadcaster).toBe("null");
    });

    it("checks if Echo is configured", async () => {
        const { configureEcho, echoIsConfigured } =
            await import("../src/config");

        expect(echoIsConfigured()).toBe(false);

        configureEcho({
            broadcaster: "null",
        });

        expect(echoIsConfigured()).toBe(true);
    });

    it("creates Echo instance from a custom connector class", async () => {
        const { configureEcho, echo } = await import("../src/config");

        class CustomConnector {
            options: unknown;

            constructor(options: unknown) {
                this.options = options;
            }
        }

        configureEcho({
            broadcaster: CustomConnector,
            authEndpoint: "/custom/auth",
        });

        const instance = echo();

        expect(instance.connector).toBeInstanceOf(CustomConnector);
        expect(instance.options.authEndpoint).toBe("/custom/auth");
    });

    // fork (D-08, P-02, P-07): without a broadcaster, the native Ably connector, with nothing from pusher-js
    it("creates the native Ably connector when no broadcaster is given", async () => {
        const { configureEcho, echo } = await import("../src/config");

        configureEcho({
            autoConnect: false,
            requestTokenFn: async () => ({ token: "x" }),
        });

        const instance = echo();

        expect(instance.options.broadcaster).toBe("ably");
        expect(instance.options).not.toHaveProperty("Pusher");
        expect(instance.connectionStatus()).toBe("disconnected");

        instance.disconnect();
    });
});
