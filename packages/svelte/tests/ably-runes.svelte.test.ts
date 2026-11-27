/**
 * The runes against the Ably core API (fork; Phase 13, mirroring Phase 11 steps 3-7): connection status through
 * Echo.onConnectionChange, Ably's base64url socket id, notification (un)subscription, presence members and
 * whispers, and model event names. The core is mocked, as in the upstream suite.
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

type Status =
    | "connected"
    | "connecting"
    | "reconnecting"
    | "disconnected"
    | "failed";

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

    const Echo = vi.fn(function (options: unknown) {
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
            // what the core's registry does on an Ably connection state change
            __emit: (next: Status, nextSocketId?: string) => {
                status = next;
                socketId = nextSocketId;
                listeners.forEach((callback) => callback(next));
            },
            __listeners: listeners,
        };

        echoInstances.push(instance);

        return instance;
    });

    return { default: Echo };
});

const getModule = async () => import("../src/index");

// an Ably socket id: base64url JSON of the connection key and client id (F-064, F-096)
const ablySocketId = (connectionKey: string, clientId: string | null) =>
    btoa(JSON.stringify({ connectionKey, clientId }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

const mount = async <T>(run: () => T) => {
    let value!: T;

    const cleanup = $effect.root(() => {
        value = run();
    });

    await tick();

    return { value, cleanup };
};

describe("Svelte runes with the Ably core API (fork)", () => {
    beforeEach(() => {
        vi.resetModules();
        echoInstances.length = 0;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("useConnectionStatus", () => {
        it("follows every status the core emits and unsubscribes on unmount", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { value: status, cleanup } = await mount(() =>
                module.useConnectionStatus(),
            );
            const instance = echoInstances[0];

            expect(status()).toBe("connecting");
            expect(instance.onConnectionChange).toHaveBeenCalledTimes(1);

            for (const next of [
                "connected",
                "reconnecting",
                "disconnected",
                "failed",
                "connecting",
            ] as const) {
                instance.__emit(next);
                await tick();
                expect(status()).toBe(next);
            }

            cleanup();
            expect(instance.__listeners.size).toBe(0);
        });

        it("throws before configureEcho() in the browser, as upstream", async () => {
            const module = await getModule();

            expect(() =>
                $effect.root(() => {
                    module.useConnectionStatus();
                }),
            ).toThrow("Echo has not been configured");
        });
    });

    describe("useSocketId", () => {
        it("is undefined before the connection and follows Ably's socket id", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { value: socketId, cleanup } = await mount(() =>
                module.useSocketId(),
            );
            const instance = echoInstances[0];

            expect(socketId()).toBeUndefined();

            const first = ablySocketId("key-1!abc", "user-1");

            instance.__emit("connected", first);
            await tick();
            expect(socketId()).toBe(first);
            expect(JSON.parse(atob(first))).toEqual({
                connectionKey: "key-1!abc",
                clientId: "user-1",
            });

            // a reconnect gets a new connection key
            const second = ablySocketId("key-2!def", "user-1");

            instance.__emit("reconnecting");
            await tick();
            expect(socketId()).toBeUndefined();

            instance.__emit("connected", second);
            await tick();
            expect(socketId()).toBe(second);

            cleanup();
            expect(instance.__listeners.size).toBe(0);
        });
    });

    describe("useEchoNotification", () => {
        it("unsubscribes the same notification callback it subscribed on unmount", async () => {
            const module = await getModule();

            module.configureEcho({});

            const callback = vi.fn();
            const { cleanup } = await mount(() =>
                module.useEchoNotification(
                    "App.Models.User.1",
                    callback,
                    "App.Notifications.InvoicePaid",
                ),
            );
            const instance = echoInstances[0];
            const channel = instance.private.mock.results[0].value;

            expect(instance.private).toHaveBeenCalledWith("App.Models.User.1");
            expect(channel.notification).toHaveBeenCalledTimes(1);

            const listener = channel.notification.mock.calls[0][0];

            // the dotted event name matches Laravel's namespaced notification type
            listener({ type: "App\\Notifications\\InvoicePaid", id: "n1" });
            listener({ type: "App\\Notifications\\Other", id: "n2" });

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith({
                type: "App\\Notifications\\InvoicePaid",
                id: "n1",
            });

            cleanup();

            expect(channel.stopListeningForNotification).toHaveBeenCalledWith(
                listener,
            );
            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "App.Models.User.1",
                "private",
            );
        });
    });

    describe("useEchoPresence", () => {
        it("forwards here, joining, leaving and whispers to the presence channel unchanged", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { value, cleanup } = await mount(() =>
                module.useEchoPresence("chat.1", ".MessageSent", () => {}),
            );
            const instance = echoInstances[0];
            const channel = instance.join.mock.results[0].value;

            expect(instance.join).toHaveBeenCalledWith("chat.1");
            expect(value.channel()).toBe(channel);

            const here = vi.fn();
            const joining = vi.fn();
            const leaving = vi.fn();
            const onWhisper = vi.fn();

            value.channel().here(here);
            value.channel().joining(joining);
            value.channel().leaving(leaving);
            value.channel().whisper("typing", { name: "Ada" });
            value.channel().listenForWhisper("typing", onWhisper);

            expect(channel.here).toHaveBeenCalledWith(here);
            expect(channel.joining).toHaveBeenCalledWith(joining);
            expect(channel.leaving).toHaveBeenCalledWith(leaving);
            expect(channel.whisper).toHaveBeenCalledWith("typing", {
                name: "Ada",
            });
            expect(channel.listenForWhisper).toHaveBeenCalledWith(
                "typing",
                onWhisper,
            );

            cleanup();
            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "chat.1",
                "presence",
            );
        });
    });

    describe("useEchoModel", () => {
        it("listens for the model's namespaced events on its private channel", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { cleanup } = await mount(() =>
                module.useEchoModel("App.Models.Post", 42, [
                    "PostUpdated",
                    ".PostDeleted",
                ]),
            );
            const instance = echoInstances[0];
            const channel = instance.private.mock.results[0].value;

            expect(instance.private).toHaveBeenCalledWith("App.Models.Post.42");
            expect(
                channel.listen.mock.calls.map(([event]: [string]) => event),
            ).toEqual([".PostUpdated", ".PostDeleted"]);

            cleanup();
            expect(channel.stopListening).toHaveBeenCalledTimes(2);
            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "App.Models.Post.42",
                "private",
            );
        });
    });
});
