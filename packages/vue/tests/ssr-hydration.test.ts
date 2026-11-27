/**
 * fork (P-09, option B; F-206): the client side of server-side rendering, in the browser (jsdom). The composables
 * detect the server render by Vue's SSR context, not by a missing `window`: renderToString creates no Echo
 * instance here although `window` exists, and hydration then subscribes exactly once, as a client-only mount does.
 * tests/ssr.test.ts renders in Node without a DOM.
 */
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";
import { createSSRApp, defineComponent, h, nextTick, type Ref } from "vue";
import { renderToString } from "vue/server-renderer";

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

    const Echo = vi.fn(function (options: Record<string, unknown>) {
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
            onConnectionChange: vi.fn(() => () => {}),
        };

        echoInstances.push(instance);

        return instance;
    });

    return { default: Echo };
});

const getModule = async () => import("../src/index");

describe("hydrating server-rendered markup (P-09, option B)", () => {
    beforeEach(() => {
        vi.resetModules();
        echoInstances.length = 0;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("subscribes exactly once on the client and not during the server render", async () => {
        const module = await getModule();
        let status!: Ref<string>;

        const App = defineComponent({
            setup() {
                status = module.useConnectionStatus();
                module.useEcho("orders", "OrderShipped", () => {});
                module.useEchoNotification("App.User.1");

                return () => h("div", "orders");
            },
        });

        module.configureEcho({});

        expect(typeof window).toBe("object");

        const html = await renderToString(createSSRApp(App));

        expect(html).toBe("<div>orders</div>");
        expect(echoInstances).toHaveLength(0);

        const container = document.createElement("div");
        container.innerHTML = html;
        createSSRApp(App).mount(container);
        await nextTick();

        expect(echoInstances).toHaveLength(1);

        const [instance] = echoInstances;

        expect(instance.private).toHaveBeenCalledTimes(2);
        expect(instance.private).toHaveBeenCalledWith("orders");
        expect(instance.private).toHaveBeenCalledWith("App.User.1");
        expect(
            instance.private.mock.results[0].value.listen,
        ).toHaveBeenCalledTimes(1);
        expect(
            instance.private.mock.results[1].value.notification,
        ).toHaveBeenCalledTimes(1);
        expect(instance.onConnectionChange).toHaveBeenCalledTimes(1);
        expect(status.value).toBe("connected");
        expect(container.innerHTML).toBe("<div>orders</div>");
    });
});
