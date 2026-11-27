/**
 * The adapters neither import nor inject pusher-js (fork, P-07): Pusher and Reverb use the app's own copy, passed
 * as `Pusher` or set as `window.Pusher`, while the native Ably default needs neither. These tests use the real
 * core with a fake Pusher class, so nothing connects.
 */
import { mount } from "@vue/test-utils";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";
import { defineComponent, h } from "vue";

class FakePusher {
    static instances: FakePusher[] = [];

    connection = {
        state: "connected",
        socket_id: "123.456",
        bind: vi.fn(),
        unbind: vi.fn(),
    };

    disconnect = vi.fn();

    constructor(
        public key: string,
        public options: Record<string, unknown>,
    ) {
        FakePusher.instances.push(this);
    }
}

type PusherWindow = { Pusher?: unknown };

const getModule = async () => import("../src/index");

const mountStatus = (
    useConnectionStatus: Awaited<
        ReturnType<typeof getModule>
    >["useConnectionStatus"],
) =>
    mount(
        defineComponent({
            setup() {
                const status = useConnectionStatus();

                return () => h("div", status.value);
            },
        }),
    );

describe("Pusher and Reverb without a bundled pusher-js", () => {
    beforeEach(() => {
        vi.resetModules();
        FakePusher.instances = [];
        delete (window as unknown as PusherWindow).Pusher;
    });

    afterEach(() => {
        delete (window as unknown as PusherWindow).Pusher;
    });

    it("uses the Pusher class passed to configureEcho", async () => {
        const { configureEcho, echo, useConnectionStatus } = await getModule();

        configureEcho({
            broadcaster: "reverb",
            key: "reverb-key",
            Pusher: FakePusher as never,
        });

        const wrapper = mountStatus(useConnectionStatus);

        expect(wrapper.text()).toBe("connected");
        expect(FakePusher.instances).toHaveLength(1);
        expect(FakePusher.instances[0].key).toBe("reverb-key");
        expect(echo().socketId()).toBe("123.456");
    });

    it("picks up window.Pusher when no Pusher option is given", async () => {
        const { configureEcho, useConnectionStatus } = await getModule();

        (window as unknown as PusherWindow).Pusher = FakePusher;

        configureEcho({ broadcaster: "pusher", key: "pusher-key" });

        const wrapper = mountStatus(useConnectionStatus);

        expect(wrapper.text()).toBe("connected");
        expect(FakePusher.instances).toHaveLength(1);
        expect(FakePusher.instances[0].key).toBe("pusher-key");
    });

    it("needs neither for the native Ably default", async () => {
        const { configureEcho, echo, useConnectionStatus } = await getModule();

        configureEcho({
            autoConnect: false,
            requestTokenFn: async () => ({ token: "x" }),
        });

        const wrapper = mountStatus(useConnectionStatus);

        expect(wrapper.text()).toBe("disconnected");
        expect(echo().options.broadcaster).toBe("ably");
        expect(echo().options).not.toHaveProperty("Pusher");
        expect(FakePusher.instances).toHaveLength(0);

        wrapper.unmount();
        echo().disconnect();
    });

    it.each(["pusher", "reverb"] as const)(
        "explains how to provide Pusher when %s has none",
        async (broadcaster) => {
            const { configureEcho, echo } = await getModule();

            configureEcho({ broadcaster, key: "app-key" });

            expect(() => echo()).toThrow(
                `The "${broadcaster}" broadcaster needs pusher-js, which @ably/laravel-echo-vue does not bundle.`,
            );
            expect(() => echo()).toThrow(
                `configureEcho({ broadcaster: "${broadcaster}", Pusher })`,
            );
            expect(() => echo()).toThrow("window.Pusher = Pusher");
        },
    );

    it("does not ask for Pusher when a Pusher client instance is passed", async () => {
        const { configureEcho, echo } = await getModule();
        const client = new FakePusher("client-key", {});

        configureEcho({ broadcaster: "pusher", client: client as never });

        expect(echo().socketId()).toBe("123.456");
    });
});
