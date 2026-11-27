/**
 * configureEcho() with the real core (fork, Phase 11): the native Ably default (D-08, P-02) and a custom connector
 * class (F-098). Every Ably case uses `autoConnect: false` and a `requestTokenFn`, so nothing connects.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ablyOptions = {
    autoConnect: false,
    requestTokenFn: async () => ({ token: "x" }),
};

const getModule = async () => import("../src/index");

describe("configureEcho with the real core (fork)", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("uses the native Ably connector without a broadcaster, and no Pusher", async () => {
        const { configureEcho, echo } = await getModule();

        configureEcho(ablyOptions);

        const instance = echo();

        expect(instance.options.broadcaster).toBe("ably");
        expect(instance.options).not.toHaveProperty("Pusher");
        expect(instance.connectionStatus()).toBe("disconnected");
        expect(instance.socketId()).toBeUndefined();

        instance.disconnect();
    });

    it("passes a custom connector class through without the ably defaults (F-098)", async () => {
        const { configureEcho, echo } = await getModule();

        class CustomConnector {
            constructor(public options: Record<string, unknown>) {}
        }

        configureEcho({
            broadcaster: CustomConnector,
            requestTokenFn: ablyOptions.requestTokenFn,
        });

        const instance = echo();

        expect(instance.connector).toBeInstanceOf(CustomConnector);
        expect(instance.options.broadcaster).toBe(CustomConnector);
        expect(
            (instance.connector as unknown as CustomConnector).options
                .requestTokenFn,
        ).toBe(ablyOptions.requestTokenFn);
    });
});
