// @vitest-environment node
/**
 * A client runtime without `window` (fork, P-09): a Web Worker, a custom renderer or Node tests run the runes with
 * the client runtime's effect context but no `window`. They must subscribe exactly as upstream does; only
 * svelte/server's render() (no effect context) skips the subscription (tests/ssr.test.ts).
 */
import { tick } from "svelte";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";

const { echoInstances } = vi.hoisted(() => ({
    echoInstances: [] as any[],
}));

vi.mock("@ably/laravel-echo", () => {
    const channel = () => ({
        listen: vi.fn(),
        stopListening: vi.fn(),
        notification: vi.fn(),
        stopListeningForNotification: vi.fn(),
    });

    const Echo = vi.fn(function (options: unknown) {
        const listeners = new Set<(status: string) => void>();
        const unsubscribe = vi.fn();

        const instance = {
            options,
            private: vi.fn(() => channel()),
            channel: vi.fn(() => channel()),
            join: vi.fn(() => channel()),
            leave: vi.fn(),
            leaveChannel: vi.fn(),
            leaveAllChannels: vi.fn(),
            connectionStatus: vi.fn(() => "connected"),
            socketId: vi.fn(() => "socket-1"),
            onConnectionChange: vi.fn((callback: (status: string) => void) => {
                listeners.add(callback);

                return () => {
                    listeners.delete(callback);
                    unsubscribe();
                };
            }),
            __emit: (status: string) =>
                listeners.forEach((callback) => callback(status)),
            __unsubscribe: unsubscribe,
        };

        echoInstances.push(instance);

        return instance;
    });

    return { default: Echo };
});

describe("client runtime without window (P-09)", () => {
    beforeEach(() => {
        vi.resetModules();
        echoInstances.length = 0;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("subscribes, listens and leaves as upstream", async () => {
        expect(typeof window).toBe("undefined");

        const module = await import("../src");

        module.configureEcho({});

        const callback = vi.fn();
        let status!: () => string;
        let socketId!: () => string | undefined;
        let orders!: { channel: () => unknown };

        const cleanup = $effect.root(() => {
            orders = module.useEcho("orders", ".OrderShipped", callback);
            module.useChannel("account");
            module.useEchoPublic("posts", ".PostPublished", () => {});
            module.useEchoNotification("App.Models.User.1", () => {});
            status = module.useConnectionStatus();
            socketId = module.useSocketId();
        });

        await tick();

        const [instance] = echoInstances;

        expect(echoInstances).toHaveLength(1);
        expect(instance.private.mock.calls).toEqual([
            ["orders"],
            ["account"],
            ["App.Models.User.1"],
        ]);
        expect(instance.channel).toHaveBeenCalledWith("posts");
        expect(orders.channel()).toBe(instance.private.mock.results[0].value);

        const ordersChannel = instance.private.mock.results[0].value;

        expect(ordersChannel.listen).toHaveBeenCalledWith(
            ".OrderShipped",
            expect.any(Function),
        );
        expect(
            instance.private.mock.results[2].value.notification,
        ).toHaveBeenCalledTimes(1);

        expect(status()).toBe("connected");
        expect(socketId()).toBe("socket-1");
        expect(instance.onConnectionChange).toHaveBeenCalledTimes(2);

        instance.__emit("reconnecting");
        await tick();
        expect(status()).toBe("reconnecting");

        cleanup();

        expect(instance.__unsubscribe).toHaveBeenCalledTimes(2);
        expect(instance.leaveChannel.mock.calls).toEqual(
            expect.arrayContaining([
                ["orders", "private"],
                ["account", "private"],
                ["posts", "public"],
                ["App.Models.User.1", "private"],
            ]),
        );
        expect(instance.leaveChannel).toHaveBeenCalledTimes(4);
    });

    it("throws before configureEcho(), as upstream", async () => {
        const module = await import("../src");

        expect(() =>
            $effect.root(() => {
                module.useEcho("orders", ".OrderShipped", () => {});
            }),
        ).toThrow("Echo has not been configured");
    });

    it("skips a rune called outside any effect, as it cannot tell it from a server render (documented limit)", async () => {
        const module = await import("../src");

        module.configureEcho({});

        const hook = module.useEcho("orders", ".OrderShipped", () => {});

        expect(hook.channel()).toBeNull();
        expect(echoInstances).toHaveLength(0);
    });
});
