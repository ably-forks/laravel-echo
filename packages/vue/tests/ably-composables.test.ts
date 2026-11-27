/**
 * The Vue composables with Ably naming (Phase 12, as Phase 11 steps 4-7): socket ids, notifications, presence
 * callbacks and model events, next to upstream's own tests in useEcho.test.ts. The core is mocked, with a fresh
 * channel object per subscription.
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
import { defineComponent, h, nextTick } from "vue";

type Status = "connected" | "connecting" | "disconnected";

const { echoInstances } = vi.hoisted(() => ({
    echoInstances: [] as any[],
}));

vi.mock("@ably/laravel-echo", () => {
    const channel = () => ({
        listen: vi.fn(),
        stopListening: vi.fn(),
        notification: vi.fn(),
        stopListeningForNotification: vi.fn(),
        here: vi.fn(),
        joining: vi.fn(),
        leaving: vi.fn(),
        whisper: vi.fn(),
        listenForWhisper: vi.fn(),
    });

    const Echo = vi.fn(function (options: Record<string, unknown>) {
        const listeners = new Set<(status: Status) => void>();
        let status: Status = "connecting";
        let socketId: string | undefined;

        const instance = {
            options,
            private: vi.fn(() => channel()),
            channel: vi.fn(() => channel()),
            join: vi.fn(() => channel()),
            leave: vi.fn(),
            leaveChannel: vi.fn(),
            leaveAllChannels: vi.fn(),
            connectionStatus: vi.fn(() => status),
            socketId: vi.fn(() => socketId),
            onConnectionChange: vi.fn((callback: (s: Status) => void) => {
                listeners.add(callback);

                return () => listeners.delete(callback);
            }),
            // an emission of Echo's registry, with the connection's new socket id
            __emit: (next: Status, nextSocketId?: string) => {
                status = next;
                socketId = nextSocketId;
                listeners.forEach((callback) => callback(next));
            },
        };

        echoInstances.push(instance);

        return instance;
    });

    return { default: Echo };
});

const getModule = async () => import("../src/index");

/**
 * Mounts a component whose setup runs the composable: `result` is what setup returned.
 */
const renderComposable = <T>(setup: () => T) => {
    let result!: T;

    const wrapper = mount(
        defineComponent({
            setup() {
                result = setup();

                return () => h("div");
            },
        }),
    );

    return { result, unmount: () => wrapper.unmount() };
};

/**
 * What AblyConnector.socketId() returns once connected: base64url JSON of the connection key and client id.
 */
const ablySocketId = (connectionKey: string, clientId: string | null) =>
    btoa(JSON.stringify({ connectionKey, clientId }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

describe("Vue composables with Ably naming (fork)", () => {
    beforeEach(() => {
        vi.resetModules();
        echoInstances.length = 0;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("useSocketId (F-064, F-096)", () => {
        it("is undefined before the connection and follows each new Ably socket id", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result } = renderComposable(() => module.useSocketId());
            const [instance] = echoInstances;

            expect(result.value).toBeUndefined();

            const first = ablySocketId("key-1!abc", "user-1");

            instance.__emit("connected", first);
            await nextTick();
            expect(result.value).toBe(first);
            expect(JSON.parse(atob(first))).toEqual({
                connectionKey: "key-1!abc",
                clientId: "user-1",
            });

            // a reconnection, or another client id, gives a new connection key and socket id
            const second = ablySocketId("key-2!def", "user-2");

            instance.__emit("connected", second);
            await nextTick();
            expect(result.value).toBe(second);

            instance.__emit("disconnected");
            await nextTick();
            expect(result.value).toBeUndefined();
        });
    });

    describe("useEchoNotification (F-057)", () => {
        it("registers one callback and removes that same callback on unmount", async () => {
            const module = await getModule();

            module.configureEcho({});

            const callback = vi.fn();
            const { unmount } = renderComposable(() =>
                module.useEchoNotification(
                    "App.Models.User.1",
                    callback,
                    "App.Notifications.InvoicePaid",
                ),
            );
            const [instance] = echoInstances;
            const channel = instance.private.mock.results[0].value;

            expect(instance.private).toHaveBeenCalledWith("App.Models.User.1");
            expect(channel.notification).toHaveBeenCalledTimes(1);

            const registered = channel.notification.mock.calls[0][0];

            // Laravel sends the notification class with backslashes; the dotted name matches it
            const notification = {
                id: "1",
                type: "App\\Notifications\\InvoicePaid",
                amount: 10,
            };

            registered(notification);
            registered({ id: "2", type: "App\\Notifications\\Other" });

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(notification);

            unmount();

            expect(channel.stopListeningForNotification).toHaveBeenCalledTimes(
                1,
            );
            expect(channel.stopListeningForNotification).toHaveBeenCalledWith(
                registered,
            );
            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "App.Models.User.1",
                "private",
            );
        });
    });

    describe("useEchoPresence (F-097)", () => {
        it("forwards here, joining, leaving and whisper to the presence channel unchanged", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result } = renderComposable(() =>
                module.useEchoPresence("chat.1", ".MessageSent", () => {}),
            );
            const [instance] = echoInstances;
            const channel = instance.join.mock.results[0].value;

            expect(instance.join).toHaveBeenCalledWith("chat.1");
            expect(result.channel()).toBe(channel);

            const here = vi.fn();
            const joining = vi.fn();
            const leaving = vi.fn();
            const typing = vi.fn();

            result.channel().here(here);
            result.channel().joining(joining);
            result.channel().leaving(leaving);
            result.channel().listenForWhisper("typing", typing);
            result.channel().whisper("typing", { name: "Ada" });

            expect(channel.here).toHaveBeenCalledWith(here);
            expect(channel.joining).toHaveBeenCalledWith(joining);
            expect(channel.leaving).toHaveBeenCalledWith(leaving);
            expect(channel.listenForWhisper).toHaveBeenCalledWith(
                "typing",
                typing,
            );
            expect(channel.whisper).toHaveBeenCalledWith("typing", {
                name: "Ada",
            });
        });
    });

    describe("useEchoModel (F-097)", () => {
        it("listens on the model's private channel with dot-prefixed model events", async () => {
            const module = await getModule();

            module.configureEcho({});

            const callback = vi.fn();
            const { unmount } = renderComposable(() =>
                module.useEchoModel(
                    "App.Models.User",
                    7,
                    ["UserUpdated", ".UserDeleted"],
                    callback,
                ),
            );
            const [instance] = echoInstances;
            const channel = instance.private.mock.results[0].value;

            expect(instance.private).toHaveBeenCalledWith("App.Models.User.7");
            expect(channel.listen).toHaveBeenCalledTimes(2);
            expect(channel.listen).toHaveBeenCalledWith(
                ".UserUpdated",
                callback,
            );
            expect(channel.listen).toHaveBeenCalledWith(
                ".UserDeleted",
                callback,
            );

            unmount();

            expect(channel.stopListening).toHaveBeenCalledWith(
                ".UserUpdated",
                callback,
            );
            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "App.Models.User.7",
                "private",
            );
        });
    });
});
