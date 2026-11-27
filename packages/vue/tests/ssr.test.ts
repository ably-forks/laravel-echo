// @vitest-environment node
/**
 * fork (P-09, option B; F-206): server-side rendering with vue/server-renderer, in Node without a DOM. The
 * composables must not create an Echo instance (so no Ably connection) nor subscribe, whether or not Echo is
 * configured. Without a `window` global, any code path that used it would throw a ReferenceError here.
 * tests/ssr-hydration.test.ts covers the client side.
 */
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";

const { echoInstances } = vi.hoisted(() => ({
    echoInstances: [] as any[],
}));

vi.mock("@ably/laravel-echo", () => {
    const Echo = vi.fn(function (options: Record<string, unknown>) {
        const instance = {
            options,
            private: vi.fn(),
            channel: vi.fn(),
            join: vi.fn(),
            leave: vi.fn(),
            leaveChannel: vi.fn(),
            leaveAllChannels: vi.fn(),
            connectionStatus: vi.fn(() => "connected"),
            socketId: vi.fn(() => "socket"),
            onConnectionChange: vi.fn(() => () => {}),
        };

        echoInstances.push(instance);

        return instance;
    });

    return { default: Echo };
});

const getModule = async () => import("../src/index");

/**
 * Renders every composable on the server; the markup records what they returned.
 */
const renderOnServer = async (
    module: Awaited<ReturnType<typeof getModule>>,
) => {
    const App = defineComponent({
        setup() {
            const status = module.useConnectionStatus();
            const socketId = module.useSocketId();
            const orders = module.useEcho("orders", "OrderShipped", () => {});
            const publicOrders = module.useEchoPublic("orders", "E", () => {});
            const room = module.useEchoPresence("room", "E", () => {});
            const notifications = module.useEchoNotification("App.User.1");
            const model = module.useEchoModel("App.Models.User", 1, [
                "UserUpdated",
            ]);
            const channel = module.useChannel("chat");
            const presence = module.usePresenceChannel("lobby");
            const publicChannel = module.usePublicChannel("news");

            // the returned functions are safe to call during SSR too
            orders.listen();
            orders.stopListening();
            notifications.listen();
            channel.leaveChannel();

            const channels = [
                orders,
                publicOrders,
                room,
                notifications,
                model,
                channel,
                presence,
                publicChannel,
            ].map((composable) => composable.channel());

            return () =>
                h(
                    "div",
                    `${status.value}|${socketId.value ?? "none"}|${channels.every((c) => c === null)}`,
                );
        },
    });

    return renderToString(createSSRApp(App));
};

describe("server-side rendering (P-09, option B)", () => {
    beforeEach(() => {
        vi.resetModules();
        echoInstances.length = 0;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("runs without a window global", () => {
        expect(typeof window).toBe("undefined");
    });

    it("renders without configureEcho() and without throwing", async () => {
        const module = await getModule();

        expect(module.echoIsConfigured()).toBe(false);

        const html = await renderOnServer(module);

        expect(html).toBe("<div>disconnected|none|true</div>");
        expect(echoInstances).toHaveLength(0);
    });

    it("creates no Echo instance and subscribes to nothing when Echo is configured", async () => {
        const module = await getModule();
        const Echo = (await import("@ably/laravel-echo")).default;

        module.configureEcho({});

        const html = await renderOnServer(module);

        expect(html).toBe("<div>disconnected|none|true</div>");
        // no instance means no connector, so no Ably connection is opened during the server render
        expect(Echo).not.toHaveBeenCalled();
        expect(echoInstances).toHaveLength(0);
    });
});
