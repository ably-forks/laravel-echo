/**
 * The behaviour Phase 10 changes in all three adapters (fork): the native `ably` default (D-08, P-02), leave by
 * name and visibility (P-04), connection changes through Echo.onConnectionChange (P-03), the reset on
 * reconfigure (F-082) and no pusher-js (P-07). The core is mocked; tests/pusher.test.ts uses the real one.
 */
/// <reference types="node" />
import { mount } from "@vue/test-utils";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";
import { defineComponent, h, nextTick } from "vue";

type Status = "connected" | "connecting" | "reconnecting" | "failed";

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
            // the hooks must not subscribe here: Echo.connect() replaces the connector (F-075)
            connector: { onConnectionChange: vi.fn(() => () => {}) },
            // what Echo's registry does when Echo.connect() swaps the connector: one emission of the new status
            __swapConnector: (next: Status, nextSocketId?: string) => {
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

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const getModule = async () => import("../src/index");

/**
 * Mounts a component whose setup runs the composable, standing in for React's renderHook: `result` is what setup
 * returned and `unmount` unmounts the component.
 */
const renderHook = <T>(setup: () => T) => {
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

describe("shared adapter behaviour (fork)", () => {
    beforeEach(() => {
        vi.resetModules();
        echoInstances.length = 0;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("configureEcho defaults (D-08, P-02)", () => {
        it("uses the native ably connector when no broadcaster is given, without Pusher", async () => {
            const { configureEcho, echo } = await getModule();

            configureEcho({});
            echo();

            const Echo = (await import("@ably/laravel-echo")).default;
            const options = vi.mocked(Echo).mock.calls[0][0];

            expect(options.broadcaster).toBe("ably");
            expect(options).not.toHaveProperty("Pusher");
            expect(options).not.toHaveProperty("wsHost");
            expect(options).not.toHaveProperty("key");
        });

        it("keeps the caller's ably options over the default", async () => {
            const { configureEcho } = await getModule();

            configureEcho({
                broadcaster: "ably",
                authEndpoint: "/custom/auth",
            });

            const { echo } = await getModule();
            const options = (echo() as any).options;

            expect(options).toEqual({
                broadcaster: "ably",
                authEndpoint: "/custom/auth",
            });
        });

        it("still honours an explicit driver", async () => {
            const { configureEcho, echo } = await getModule();

            configureEcho({ broadcaster: "null" });

            expect((echo() as any).options.broadcaster).toBe("null");
        });

        it("reads the Mercure hub URL from VITE_MERCURE_HUB_URL", async () => {
            vi.stubEnv(
                "VITE_MERCURE_HUB_URL",
                "https://hub.test/.well-known/mercure",
            );

            try {
                const { configureEcho, echo } = await getModule();

                configureEcho({ broadcaster: "mercure" });

                expect((echo() as any).options.host).toBe(
                    "https://hub.test/.well-known/mercure",
                );
            } finally {
                vi.unstubAllEnvs();
            }
        });
    });

    describe("leave by name and visibility (P-04)", () => {
        it.each([
            ["useEcho", "private"],
            ["useEchoPresence", "presence"],
            ["useEchoPublic", "public"],
        ] as const)(
            "%s leaves with the channel name and %s visibility on unmount",
            async (hook, visibility) => {
                const module = await getModule();

                module.configureEcho({});

                const useHook = module[hook] as (
                    channelName: string,
                    event: string,
                    callback: () => void,
                ) => unknown;

                const { unmount } = renderHook(() =>
                    useHook("orders", "OrderShipped", () => {}),
                );

                unmount();

                expect(echoInstances[0].leaveChannel).toHaveBeenCalledTimes(1);
                expect(echoInstances[0].leaveChannel).toHaveBeenCalledWith(
                    "orders",
                    visibility,
                );
            },
        );

        it.each([
            ["useChannel", "private"],
            ["usePresenceChannel", "presence"],
            ["usePublicChannel", "public"],
        ] as const)(
            "%s leaves with the channel name and %s visibility on unmount",
            async (hook, visibility) => {
                const module = await getModule();

                module.configureEcho({});

                const useHook = module[hook] as (
                    channelName: string,
                ) => unknown;

                const { unmount } = renderHook(() => useHook("orders"));

                unmount();

                expect(echoInstances[0].leaveChannel).toHaveBeenCalledWith(
                    "orders",
                    visibility,
                );
            },
        );

        it("useEchoModel and useEchoNotification leave their private channel", async () => {
            const module = await getModule();

            module.configureEcho({});

            const model = renderHook(() =>
                module.useEchoModel("App.Models.User", 7, ["UserUpdated"]),
            );
            const notification = renderHook(() =>
                module.useEchoNotification("App.Models.User.7"),
            );

            model.unmount();
            notification.unmount();

            expect(echoInstances[0].leaveChannel).toHaveBeenCalledWith(
                "App.Models.User.7",
                "private",
            );
            expect(echoInstances[0].leaveChannel).toHaveBeenCalledTimes(1);
        });

        it("tracks a public channel named private-x apart from the private channel x", async () => {
            const module = await getModule();

            module.configureEcho({});

            const publicHook = renderHook(() =>
                module.useEchoPublic("private-x", "E", () => {}),
            );
            const privateHook = renderHook(() =>
                module.useEcho("x", "E", () => {}),
            );

            const instance = echoInstances[0];

            expect(instance.channel).toHaveBeenCalledWith("private-x");
            expect(instance.private).toHaveBeenCalledWith("x");

            publicHook.unmount();

            expect(instance.leaveChannel).toHaveBeenCalledTimes(1);
            expect(instance.leaveChannel).toHaveBeenCalledWith(
                "private-x",
                "public",
            );

            privateHook.unmount();

            expect(instance.leaveChannel).toHaveBeenCalledTimes(2);
            expect(instance.leaveChannel).toHaveBeenLastCalledWith(
                "x",
                "private",
            );
        });

        it("leaves only when the last hook on a channel unmounts", async () => {
            const module = await getModule();

            module.configureEcho({});

            const first = renderHook(() => module.useEcho("x", "E", () => {}));
            const second = renderHook(() => module.useEcho("x", "F", () => {}));

            expect(echoInstances[0].private).toHaveBeenCalledTimes(1);

            first.unmount();
            expect(echoInstances[0].leaveChannel).not.toHaveBeenCalled();

            second.unmount();
            expect(echoInstances[0].leaveChannel).toHaveBeenCalledWith(
                "x",
                "private",
            );
        });

        it("a hook that already left does not release a sibling's new entry (UB-15)", async () => {
            const module = await getModule();

            module.configureEcho({});

            const first = renderHook(() => module.useEcho("x", "E", () => {}));
            const instance = echoInstances[0];

            first.result.leaveChannel();
            expect(instance.leaveChannel).toHaveBeenCalledTimes(1);

            const second = renderHook(() => module.useEcho("x", "E", () => {}));

            expect(instance.private).toHaveBeenCalledTimes(2);

            // upstream would decrement the sibling's entry here and leave the channel under it
            first.unmount();
            expect(instance.leaveChannel).toHaveBeenCalledTimes(1);

            second.unmount();
            expect(instance.leaveChannel).toHaveBeenCalledTimes(2);
        });

        it("leave() still leaves every visibility by name", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result } = renderHook(() =>
                module.useEcho("orders", "E", () => {}),
            );

            result.leave();

            expect(echoInstances[0].leave).toHaveBeenCalledWith("orders");
            expect(echoInstances[0].leaveChannel).not.toHaveBeenCalled();
        });
    });

    describe("connection changes through Echo.onConnectionChange (P-03)", () => {
        it("useConnectionStatus follows the registry across a connector swap", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result, unmount } = renderHook(() =>
                module.useConnectionStatus(),
            );
            const instance = echoInstances[0];

            expect(result.value).toBe("connecting");
            expect(instance.onConnectionChange).toHaveBeenCalledTimes(1);
            expect(
                instance.connector.onConnectionChange,
            ).not.toHaveBeenCalled();

            instance.__swapConnector("connected");
            await nextTick();
            expect(result.value).toBe("connected");

            instance.__swapConnector("reconnecting");
            await nextTick();
            expect(result.value).toBe("reconnecting");

            unmount();
            expect(instance.__listeners.size).toBe(0);
        });

        it("useSocketId re-reads the socket id on every emission", async () => {
            const module = await getModule();

            module.configureEcho({});

            const { result } = renderHook(() => module.useSocketId());
            const instance = echoInstances[0];

            expect(result.value).toBeUndefined();
            expect(
                instance.connector.onConnectionChange,
            ).not.toHaveBeenCalled();

            instance.__swapConnector("connected", "socket-a");
            await nextTick();
            expect(result.value).toBe("socket-a");

            instance.__swapConnector("connected", "socket-b");
            await nextTick();
            expect(result.value).toBe("socket-b");
        });
    });

    describe("reconfigure, as upstream React and Vue (UB-17, UB-18)", () => {
        it("keeps the old instance's channels and the registry, so a new hook shares the old entry", async () => {
            const module = await getModule();

            module.configureEcho({});

            const before = renderHook(() =>
                module.useEcho("orders", "E", () => {}),
            );
            const first = echoInstances[0];

            module.configureEcho({ authEndpoint: "/other/auth" });

            // upstream React and Vue only drop the instance
            expect(first.leaveAllChannels).not.toHaveBeenCalled();

            const after = renderHook(() =>
                module.useEcho("orders", "E", () => {}),
            );

            // the registry is kept: the new hook reuses the old subscription
            expect(first.private).toHaveBeenCalledTimes(1);
            expect(echoInstances).toHaveLength(1);

            before.unmount();
            after.unmount();

            // the last unmount leaves through echo(), now the reconfigured instance, as upstream
            expect(echoInstances).toHaveLength(2);
            expect(first.leaveChannel).not.toHaveBeenCalled();
            expect(echoInstances[1].leaveChannel).toHaveBeenCalledWith(
                "orders",
                "private",
            );
        });

        it("does not create an instance when none was created yet", async () => {
            const module = await getModule();

            module.configureEcho({});
            module.configureEcho({ broadcaster: "null" });

            expect(echoInstances).toHaveLength(0);
        });
    });

    describe("no pusher-js (P-07)", () => {
        it("does not list pusher-js or socket.io-client in the manifest", () => {
            const pkg = JSON.parse(
                readFileSync(resolve(packageDir, "package.json"), "utf8"),
            ) as Record<string, Record<string, unknown> | undefined>;

            for (const field of [
                "dependencies",
                "devDependencies",
                "peerDependencies",
                "peerDependenciesMeta",
                "typesVersions",
            ]) {
                expect(Object.keys(pkg[field] ?? {})).not.toContain(
                    "pusher-js",
                );
                expect(Object.keys(pkg[field] ?? {})).not.toContain(
                    "socket.io-client",
                );
            }

            expect(pkg.peerDependencies).toHaveProperty("@ably/laravel-echo");
            expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0);
        });

        it("does not import pusher-js or @ably/pubsub-device in the sources", () => {
            const srcDir = resolve(packageDir, "src");
            const files = (readdirSync(srcDir, { recursive: true }) as string[])
                .filter((file) => file.endsWith(".ts"))
                .map((file) => readFileSync(join(srcDir, file), "utf8"));

            expect(files.length).toBeGreaterThan(0);

            // the missing-Pusher error message names pusher-js; only an import of it is ruled out
            for (const source of files) {
                expect(source).not.toMatch(
                    /^import[^;]*["'](pusher-js|@ably\/pubsub-device)["']/m,
                );
                expect(source).not.toMatch(
                    /\b(import|require)\(\s*["'](pusher-js|@ably\/pubsub-device)["']/,
                );
                expect(source).not.toMatch(/Pusher \?\?=/);
            }
        });
    });
});
