/**
 * Hook behaviour with the native Ably connector (fork, Phase 11): connection status and socket id through
 * Echo.onConnectionChange, also across a connector replacement (F-075, F-096), the notification round-trip (F-057),
 * presence callbacks (F-097) and model event names. The core is mocked with Ably naming: bare channel names, a
 * base64url JSON socket id and Echo's connection-change registry.
 */
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode, StrictMode } from "react";
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
    const privateChannel = () => ({
        listen: vi.fn(),
        stopListening: vi.fn(),
        notification: vi.fn(),
        stopListeningForNotification: vi.fn(),
        whisper: vi.fn(),
        listenForWhisper: vi.fn(),
    });

    const presenceChannel = () => ({
        ...privateChannel(),
        // chainable, as on PresenceChannel
        here: vi.fn().mockReturnThis(),
        joining: vi.fn().mockReturnThis(),
        leaving: vi.fn().mockReturnThis(),
    });

    const Echo = vi.fn(function (options: Record<string, unknown>) {
        const listeners = new Set<(status: Status) => void>();
        let status: Status = "connecting";
        let socketId: string | undefined;

        const instance = {
            options,
            channels: {} as Record<string, any>,
            private: vi.fn(
                (name: string) =>
                    (instance.channels[`private:${name}`] ??= privateChannel()),
            ),
            channel: vi.fn(
                (name: string) =>
                    (instance.channels[name] ??= privateChannel()),
            ),
            join: vi.fn(
                (name: string) =>
                    (instance.channels[`presence:${name}`] ??=
                        presenceChannel()),
            ),
            leave: vi.fn(),
            leaveChannel: vi.fn(),
            leaveAllChannels: vi.fn(),
            connectionStatus: vi.fn(() => status),
            socketId: vi.fn(() => socketId),
            onConnectionChange: vi.fn((callback: (s: Status) => void) => {
                listeners.add(callback);

                return () => listeners.delete(callback);
            }),
            // the hooks must not subscribe here: Echo.connect() replaces the connector (F-075)
            connector: { onConnectionChange: vi.fn(() => () => {}) },
            // what Echo's registry does on a connection change, and once when Echo.connect() swaps the connector
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

/**
 * The Ably connector's socket id: base64url JSON of the connection key and client id.
 */
const ablySocketId = (connectionKey: string, clientId: string | null) =>
    btoa(JSON.stringify({ connectionKey, clientId }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

const getModule = async () => import("../src/index");

describe("hooks with the native Ably connector (fork)", () => {
    beforeEach(() => {
        vi.resetModules();
        echoInstances.length = 0;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("useConnectionStatus", () => {
        it("follows every status Echo.onConnectionChange emits", async () => {
            const module = await getModule();

            module.configureEcho({ broadcaster: "ably" });

            const { result, unmount } = renderHook(() =>
                module.useConnectionStatus(),
            );
            const instance = echoInstances[0];

            expect(result.current).toBe("connecting");
            expect(instance.onConnectionChange).toHaveBeenCalledTimes(1);

            for (const status of [
                "connected",
                "reconnecting",
                "connecting",
                "connected",
                "failed",
            ] as const) {
                act(() => {
                    instance.__emit(status);
                });

                expect(result.current).toBe(status);
            }

            expect(
                instance.connector.onConnectionChange,
            ).not.toHaveBeenCalled();

            unmount();

            expect(instance.__listeners.size).toBe(0);
        });

        it("still updates after Echo.connect() swaps the connector (F-075)", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result } = renderHook(() => module.useConnectionStatus());
            const instance = echoInstances[0];

            act(() => {
                instance.__emit("connected");
            });

            // a new connector: the registry re-binds and emits its status once; the hook keeps its subscription
            instance.connector = { onConnectionChange: vi.fn(() => () => {}) };
            act(() => {
                instance.__emit("connecting");
            });

            expect(result.current).toBe("connecting");

            act(() => {
                instance.__emit("connected");
            });

            expect(result.current).toBe("connected");
            expect(instance.onConnectionChange).toHaveBeenCalledTimes(1);
            expect(
                instance.connector.onConnectionChange,
            ).not.toHaveBeenCalled();
        });

        it("keeps one subscription per hook under StrictMode", async () => {
            const module = await getModule();

            module.configureEcho({});

            const wrapper = ({ children }: { children: ReactNode }) =>
                createElement(StrictMode, null, children);

            const { result, unmount } = renderHook(
                () => module.useConnectionStatus(),
                { wrapper },
            );
            const instance = echoInstances[0];

            expect(instance.__listeners.size).toBe(1);

            act(() => {
                instance.__emit("connected");
            });
            expect(result.current).toBe("connected");

            unmount();

            expect(instance.__listeners.size).toBe(0);
        });
    });

    describe("useSocketId", () => {
        it("is undefined until the connection is up, then the base64url JSON socket id (F-064)", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result } = renderHook(() => module.useSocketId());
            const instance = echoInstances[0];

            expect(result.current).toBeUndefined();

            const socketId = ablySocketId("key-1", "user-7");

            act(() => {
                instance.__emit("connected", socketId);
            });

            expect(result.current).toBe(socketId);
            expect(
                JSON.parse(
                    atob(result.current!.replace(/-/g, "+").replace(/_/g, "/")),
                ),
            ).toEqual({ connectionKey: "key-1", clientId: "user-7" });
        });

        it("changes on reconnect and when Echo.connect() swaps the connector (F-096)", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result } = renderHook(() => module.useSocketId());
            const instance = echoInstances[0];

            act(() => {
                instance.__emit("connected", ablySocketId("key-1", null));
            });
            expect(result.current).toBe(ablySocketId("key-1", null));

            // a reconnect resumes on a new connection key
            act(() => {
                instance.__emit("connected", ablySocketId("key-2", null));
            });
            expect(result.current).toBe(ablySocketId("key-2", null));

            // a connector swap (identity switch): the registry emits once for the new connector
            instance.connector = { onConnectionChange: vi.fn(() => () => {}) };
            act(() => {
                instance.__emit("connecting", undefined);
            });
            expect(result.current).toBeUndefined();

            act(() => {
                instance.__emit("connected", ablySocketId("key-3", "user-9"));
            });
            expect(result.current).toBe(ablySocketId("key-3", "user-9"));
            expect(instance.onConnectionChange).toHaveBeenCalledTimes(1);
        });
    });

    describe("useEchoNotification (F-057)", () => {
        it("round-trips notifications with dotted and backslashed type names", async () => {
            const module = await getModule();

            module.configureEcho({});

            const callback = vi.fn();
            const { result, unmount } = renderHook(() =>
                module.useEchoNotification(
                    "App.Models.User.7",
                    callback,
                    "App.Notifications.InvoicePaid",
                ),
            );
            const instance = echoInstances[0];

            // the Ably connector adds the "private:" prefix itself
            expect(instance.private).toHaveBeenCalledWith("App.Models.User.7");

            const channel = instance.channels["private:App.Models.User.7"];

            expect(channel.notification).toHaveBeenCalledTimes(1);

            const handler = channel.notification.mock.calls[0][0];
            const paid = {
                id: "1",
                type: "App\\Notifications\\InvoicePaid",
                amount: 10,
            };

            handler(paid);
            handler({ id: "2", type: "App.Notifications.InvoicePaid" });
            handler({ id: "3", type: "App\\Notifications\\Other" });

            expect(callback).toHaveBeenCalledTimes(2);
            expect(callback).toHaveBeenNthCalledWith(1, paid);

            // removal by the same callback, then re-registration
            act(() => {
                result.current.stopListening();
            });

            expect(channel.stopListeningForNotification).toHaveBeenCalledWith(
                handler,
            );

            handler(paid);
            expect(callback).toHaveBeenCalledTimes(2);

            act(() => {
                result.current.listen();
            });

            expect(channel.notification).toHaveBeenCalledTimes(2);
            expect(channel.notification.mock.calls[1][0]).toBe(handler);

            handler(paid);
            expect(callback).toHaveBeenCalledTimes(3);

            unmount();

            expect(channel.stopListeningForNotification).toHaveBeenCalledTimes(
                2,
            );
            expect(channel.stopListeningForNotification.mock.calls[1][0]).toBe(
                handler,
            );
            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "App.Models.User.7",
                "private",
            );
        });
    });

    describe("useEchoPresence (F-097)", () => {
        it("forwards here, joining, leaving and whisper to the presence channel unchanged", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result, unmount } = renderHook(() =>
                module.useEchoPresence("room.1", "MessageSent", vi.fn()),
            );
            const instance = echoInstances[0];

            expect(instance.join).toHaveBeenCalledWith("room.1");

            const presence = instance.channels["presence:room.1"];
            const channel = result.current.channel()!;

            expect(channel).toBe(presence);
            expect(presence.listen).toHaveBeenCalledWith(
                "MessageSent",
                expect.any(Function),
            );

            const here = vi.fn();
            const joining = vi.fn();
            const leaving = vi.fn();
            const typing = vi.fn();

            channel.here(here).joining(joining).leaving(leaving);
            channel.listenForWhisper("typing", typing);
            channel.whisper("typing", { name: "Ann" });

            // the hook returns Echo's channel itself, so the callbacks reach it as given
            expect(presence.here).toHaveBeenCalledWith(here);
            expect(presence.joining).toHaveBeenCalledWith(joining);
            expect(presence.leaving).toHaveBeenCalledWith(leaving);
            expect(presence.listenForWhisper).toHaveBeenCalledWith(
                "typing",
                typing,
            );
            expect(presence.whisper).toHaveBeenCalledWith("typing", {
                name: "Ann",
            });

            unmount();

            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "room.1",
                "presence",
            );
        });
    });

    describe("useEchoModel", () => {
        it("listens for the model's events with a leading dot, as upstream", async () => {
            const module = await getModule();

            module.configureEcho({});

            const callback = vi.fn();

            renderHook(() =>
                module.useEchoModel<{ name: string }, "App.Models.User">(
                    "App.Models.User",
                    7,
                    ["UserUpdated", ".UserDeleted"],
                    callback,
                ),
            );

            const instance = echoInstances[0];

            expect(instance.private).toHaveBeenCalledWith("App.Models.User.7");

            const channel = instance.channels["private:App.Models.User.7"];

            expect(
                channel.listen.mock.calls.map((call: any[]) => call[0]),
            ).toEqual([".UserUpdated", ".UserDeleted"]);

            const handler = channel.listen.mock.calls[0][1];
            const payload = { model: { name: "Ann" } };

            handler(payload);

            expect(callback).toHaveBeenCalledWith(payload);
        });
    });
});
