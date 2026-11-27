import {
    vi,
    describe,
    test,
    expect,
    beforeEach,
    afterEach,
    expectTypeOf,
} from "vite-plus/test";
/**
 * Phase 06 (P-01, provisional): AblyConnector.connectionStatus() / onConnectionChange(). No network: Echo creates
 * its client through a wrapped createClient that returns a fake client (tests/parity/fake-ably.ts), so AblyAuth's
 * 40102 handler and the re-attach latch are installed exactly as for a real client. Numbers refer to the tests in
 * PHASE-06 "Tests".
 */
import * as AblyDevice from "@ably/pubsub-device";

// createClient is a non-configurable getter on the real module: wrap the module so a test can return a fake client
vi.mock("@ably/pubsub-device", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@ably/pubsub-device")>();
    return {
        ...actual,
        createClient: vi.fn((options) => actual.createClient(options)),
    };
});
import Echo, { type ConnectionStatus } from "../../src/echo";
import { AblyConnector } from "../../src/connector/ably-connector";
import { NullConnector } from "../../src/connector";
import { fromBase64UrlEncoded } from "../../src/channel/ably/utils";
import { ablyError, makeFakeAblyClient } from "../parity/fake-ably";

const SWITCH = 40102;

/** A fake client with what an Echo-created client also needs (AblyAuth's getTimestamp, close()). */
const makeEchoClient = (clientId: string | null = null) => {
    const client = makeFakeAblyClient(clientId);
    client.getTimestamp = vi.fn(() => Promise.resolve(Date.now()));
    client.close = vi.fn(() => {
        if (client.connection.state !== "closed") {
            client.connection.transition("closing");
            client.connection.transition("closed");
        }
    });
    return client;
};

/** Echo with an Echo-created client (AblyAuth installed), which is the fake returned by createClient. */
const echoWithClient = (options: Record<string, unknown> = {}) => {
    const client = makeEchoClient();
    vi.mocked(AblyDevice.createClient).mockReturnValueOnce(client);
    const echo = new Echo({
        broadcaster: "ably",
        requestTokenFn: async () => ({ token: "" }),
        withoutInterceptors: true,
        ...options,
    });
    expect(echo.connector.ably).toBe(client);
    return {
        echo,
        connector: echo.connector,
        client,
        connection: client.connection,
    };
};

/** Echo with a supplied options.client (no AblyAuth). */
const echoWithSuppliedClient = (client = makeEchoClient()) => {
    const echo = new Echo({
        broadcaster: "ably",
        client,
        withoutInterceptors: true,
    });
    return {
        echo,
        connector: echo.connector,
        client,
        connection: client.connection,
    };
};

const record = (connector: AblyConnector) => {
    const seen: ConnectionStatus[] = [];
    const off = connector.onConnectionChange((status) => seen.push(status));
    return { seen, off };
};

const connectFully = (connection: any, key = "key-1") => {
    connection.transition("connecting");
    connection.key = key;
    connection.transition("connected");
};

const listenerCount = (connection: any) =>
    connection.any.length +
    Object.values(connection.events as Record<string, unknown[]>).reduce(
        (sum, listeners) => sum + listeners.length,
        0,
    );

beforeEach(() => {
    // the fake channels have no _attach to patch: AblyAuth's pre-attach hook warns once per client
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(AblyDevice.createClient).mockClear();
});

describe("1: the P-01 (A) mapping", () => {
    test.each([
        // [ably state, has connected before, status]
        ["connecting", false, "connecting"],
        ["connecting", true, "reconnecting"],
        ["connected", true, "connected"],
        ["disconnected", false, "connecting"],
        ["disconnected", true, "reconnecting"],
        ["suspended", false, "disconnected"],
        ["suspended", true, "disconnected"],
        ["closing", true, "disconnected"],
        ["closed", false, "disconnected"],
        ["closed", true, "disconnected"],
        ["failed", false, "failed"],
        ["failed", true, "failed"],
    ] as const)("%s (connected before: %s) -> %s", (state, before, status) => {
        const { echo, connection } = echoWithClient();
        if (before) connectFully(connection);
        connection.state = state;
        expect(echo.connector.connectionStatus()).toBe(status);
        expect(echo.connectionStatus()).toBe(status);
    });

    test.each([
        [{ autoConnect: false }, "disconnected"],
        [{ autoConnect: true }, "connecting"],
        [{}, "connecting"],
    ])("initialized with Echo options %o -> %s", (options, status) => {
        const { echo } = echoWithClient(options);
        expect(echo.connector.ably.connection.state).toBe("initialized");
        expect(echo.connectionStatus()).toBe(status);
    });

    test.each([
        [{ autoConnect: false }, "disconnected"],
        [{ autoConnect: true }, "connecting"],
        [{}, "connecting"],
    ])(
        "initialized options.client with client.options %o -> %s (F-176)",
        (clientOptions, status) => {
            const client = makeEchoClient();
            client.options = clientOptions;
            const { echo } = echoWithSuppliedClient(client);
            expect(echo.connectionStatus()).toBe(status);
        },
    );

    test("F-176: a real @ably/pubsub-device client keeps autoConnect in client.options", () => {
        const client = vi
            .mocked(AblyDevice.createClient)
            .getMockImplementation()!({ key: "a.b:c", autoConnect: false });
        const echo = new Echo({
            broadcaster: "ably",
            client,
            withoutInterceptors: true,
        });
        expect(client.connection.state).toBe("initialized");
        expect(echo.connectionStatus()).toBe("disconnected");
        client.close();
    });

    test("no client at all -> disconnected", () => {
        expect(AblyConnector.prototype.connectionStatus.call({})).toBe(
            "disconnected",
        );
    });
});

describe("2-5: the 40102 of Echo's own clientId reconnect", () => {
    test("2: connected -> failed(40102) -> nested connecting -> connected emits reconnecting, connected; never failed", () => {
        const { echo, connector, client, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        const sampled: ConnectionStatus[] = [];
        connector.onConnectionChange(() =>
            sampled.push(echo.connectionStatus()),
        );

        connection.transition(
            "failed",
            ablyError("mismatched clientId", SWITCH),
        );
        sampled.push(echo.connectionStatus());
        expect(client.connect).toHaveBeenCalledTimes(1); // AblyAuth reconnected: nested `connecting`
        expect(connection.state).toBe("connecting");
        connection.transition("connected");
        sampled.push(echo.connectionStatus());

        expect(seen).toEqual(["reconnecting", "connected"]);
        expect(sampled).not.toContain("failed");
        expect(connector.ablyAuth!.reconnectingForClientIdChange).toBe(false);
    });

    test("3: a second 40102 before `connected` (handler disarmed) emits failed at once", () => {
        const { connector, client, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);

        connection.transition("failed", ablyError("x", SWITCH));
        connection.transition("failed", ablyError("x", SWITCH));

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(seen).toEqual(["reconnecting", "failed"]);
        expect(connector.connectionStatus()).toBe("failed");
    });

    test("4: a suppressed 40102 whose connection stays failed emits failed after 1000 ms", () => {
        vi.useFakeTimers();
        const { connector, client, connection } = echoWithClient();
        connectFully(connection);
        client.connect.mockImplementation(() => undefined); // the reconnect does not start
        const { seen } = record(connector);

        connection.transition("failed", ablyError("x", SWITCH));
        expect(seen).toEqual(["reconnecting"]);
        expect(connector.connectionStatus()).toBe("reconnecting");
        vi.advanceTimersByTime(999);
        expect(seen).toEqual(["reconnecting"]);
        vi.advanceTimersByTime(1);

        expect(seen).toEqual(["reconnecting", "failed"]);
        expect(connector.ablyAuth!.reconnectingForClientIdChange).toBe(false);
        expect(connector.connectionStatus()).toBe("failed");
    });

    test("4b: any later event cancels the fallback timer", () => {
        vi.useFakeTimers();
        const { connector, client, connection } = echoWithClient();
        connectFully(connection);
        client.connect.mockImplementation(() => undefined);
        const { seen } = record(connector);

        connection.transition("failed", ablyError("x", SWITCH));
        vi.advanceTimersByTime(500);
        connection.transition("connecting");
        vi.advanceTimersByTime(5000);
        connection.transition("connected");

        expect(seen).toEqual(["reconnecting", "connected"]);
    });

    test("5: a first-connect 40102 is reported as connecting, retried once (P-18), then failed", () => {
        const { connector, client, connection } = echoWithClient();
        const { seen } = record(connector);
        const sampled: ConnectionStatus[] = [];
        const step = (state: string, reason?: unknown) => {
            connection.transition(state, reason);
            sampled.push(connector.connectionStatus());
        };

        step("connecting");
        step("failed", ablyError("x", SWITCH)); // armed: reconnects (nested connecting)
        step("failed", ablyError("x", SWITCH)); // disarmed: a real failure

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(sampled).toEqual(["connecting", "connecting", "failed"]);
        expect(seen).toEqual(["failed"]); // `connecting` was already the status when subscribing
    });

    test("a non-40102 failure is failed", () => {
        const { connector, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        connection.transition("failed", ablyError("x", 40160));
        expect(seen).toEqual(["failed"]);
    });

    test("closing clears the flag (F-173)", () => {
        const { connector, client, connection } = echoWithClient();
        connectFully(connection);
        client.connect.mockImplementation(() => undefined);
        connection.transition("failed", ablyError("x", SWITCH));
        expect(connector.ablyAuth!.reconnectingForClientIdChange).toBe(true);
        connection.transition("closing");
        expect(connector.ablyAuth!.reconnectingForClientIdChange).toBe(false);
        connection.state = "failed";
        expect(connector.connectionStatus()).toBe("failed");
    });

    test("6: with options.client (no AblyAuth) a 40102 is failed", () => {
        const { connector, client, connection } = echoWithSuppliedClient();
        connectFully(connection);
        const { seen } = record(connector);
        connection.transition("failed", ablyError("x", SWITCH));
        expect(client.connect).not.toHaveBeenCalled();
        expect(seen).toEqual(["failed"]);
    });

    test("6: an already connected options.client counts as connected before", () => {
        const client = makeEchoClient();
        connectFully(client.connection);
        const { connector, connection } = echoWithSuppliedClient(client);
        const { seen } = record(connector);
        connection.transition("disconnected");
        expect(seen).toEqual(["reconnecting"]);
    });
});

describe("emission rules", () => {
    test("callbacks are not called on subscribe", () => {
        const { connector, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        expect(seen).toEqual([]);
    });

    test("7: dedupe: disconnected -> suspended -> disconnected after a connection", () => {
        const { connector, connection } = echoWithClient();
        const { seen } = record(connector);
        connectFully(connection);
        connection.transition("disconnected");
        connection.transition("connecting");
        connection.transition("disconnected");
        connection.transition("suspended");
        connection.transition("suspended");
        connection.transition("disconnected");
        expect(seen).toEqual([
            "connected",
            "reconnecting",
            "disconnected",
            "reconnecting",
        ]);
    });

    test("8: an event whose state is not the live state is dropped", () => {
        const { connector, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        connection.emit("disconnected", {
            previous: "connected",
            current: "disconnected",
        }); // the live state is still `connected`
        connection.state = "disconnected"; // a later change whose own event has not been dispatched yet
        connection.emit("connected", {
            previous: "connecting",
            current: "connected",
        }); // stale: not reported, nor mapped from the live state
        expect(seen).toEqual([]);
    });

    test("8: the outer, stale failed(40102) after the nested connecting starts no fallback timer", () => {
        vi.useFakeTimers();
        const { connector, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        connection.transition("failed", ablyError("x", SWITCH));
        vi.advanceTimersByTime(0); // onClientIdChanged's re-attach
        expect(vi.getTimerCount()).toBe(0);
        expect(seen).toEqual(["reconnecting"]);
    });

    test("15: a stale `connected` still records that the client has connected", () => {
        const { connector, connection } = echoWithClient();
        connection.state = "disconnected";
        expect(connector.connectionStatus()).toBe("connecting");
        connection.emit("connected", {
            previous: "connecting",
            current: "connected",
        }); // stale: the live state is `disconnected`
        expect(connector.connectionStatus()).toBe("reconnecting");
    });

    test("12: a throwing callback does not stop the others", () => {
        const error = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        const { connector, connection } = echoWithClient();
        const boom = new Error("boom");
        connector.onConnectionChange(() => {
            throw boom;
        });
        const { seen } = record(connector);
        connectFully(connection);
        expect(seen).toEqual(["connected"]);
        expect(error).toHaveBeenCalledWith(boom);
    });

    test("the unsubscribe function stops the callback", () => {
        const { connector, connection } = echoWithClient();
        const { seen, off } = record(connector);
        connection.transition("connecting");
        connection.key = "k";
        off();
        off(); // idempotent
        connection.transition("connected");
        expect(seen).toEqual([]);
    });

    test("13: a socketId() change with the same status emits (clientId switch, new connection key)", () => {
        const { echo, connector, client, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        const before = echo.socketId();

        client.auth.clientId = "user-1"; // in-band login: ably emits `update`
        connection.emit("update", {
            previous: "connected",
            current: "connected",
        });
        expect(seen).toEqual(["connected"]);
        expect(echo.socketId()).not.toBe(before);

        connection.key = "key-2";
        connection.emit("update", {
            previous: "connected",
            current: "connected",
        });
        connection.emit("update", {
            previous: "connected",
            current: "connected",
        }); // nothing changed
        expect(seen).toEqual(["connected", "connected"]);
    });

    test("14: AblyAuth's failed listener runs before the status listener", () => {
        const { connector, client, connection } = echoWithClient();
        connectFully(connection);
        client.connect.mockImplementation(() => undefined); // keep the event live (not stale)
        const flagSeen: boolean[] = [];
        connector.onConnectionChange(() =>
            flagSeen.push(connector.ablyAuth!.reconnectingForClientIdChange),
        );

        const failed: Function[] = connection.events["failed"];
        const authIndex = failed.indexOf(
            connector.ablyAuth!.clientIdSwitchListeners!.failed,
        );
        const statusIndex = failed.indexOf(
            (connector as any).connectionStatusListener,
        );
        expect(authIndex).toBeGreaterThanOrEqual(0);
        expect(statusIndex).toBeGreaterThan(authIndex);
        expect(connection.any).toEqual([]); // ably calls catch-all listeners first: never bound as one

        connection.transition("failed", ablyError("x", SWITCH));
        expect(flagSeen).toEqual([true]);
    });

    test("14: the same order on a real @ably/pubsub-device client", () => {
        const { echo } = {
            echo: new Echo({
                broadcaster: "ably",
                requestTokenFn: async () => ({ token: "" }),
                autoConnect: false,
                withoutInterceptors: true,
            }),
        };
        const connection = echo.connector.ably.connection as any;
        const failed: Function[] = connection.events["failed"];
        const authIndex = failed.indexOf(
            echo.connector.ablyAuth!.clientIdSwitchListeners!.failed,
        );
        const statusIndex = failed.indexOf(
            (echo.connector as any).connectionStatusListener,
        );
        expect(authIndex).toBeGreaterThanOrEqual(0);
        expect(statusIndex).toBeGreaterThan(authIndex);
        expect(connection.any).toEqual([]);
        echo.disconnect();
    });
});

describe("9-10: releaseClient() and connect() called again", () => {
    test("9: releaseClient() removes the status listener and cancels the fallback timer", () => {
        vi.useFakeTimers();
        const { connector, client, connection } = echoWithClient();
        connectFully(connection);
        client.connect.mockImplementation(() => undefined);
        const { seen } = record(connector);
        connection.transition("failed", ablyError("x", SWITCH));
        expect(seen).toEqual(["reconnecting"]);

        connector.releaseClient();
        vi.advanceTimersByTime(5000);
        connection.transition("connected");

        expect(seen).toEqual(["reconnecting"]);
        expect(listenerCount(connection)).toBe(0);
    });

    test("9: a reused options.client keeps no Echo listener after releaseClient()", () => {
        const client = makeEchoClient();
        expect(listenerCount(client.connection)).toBe(0);
        const { echo, connector } = echoWithSuppliedClient(client);
        expect(listenerCount(client.connection)).toBeGreaterThan(0);
        echo.connect();
        echo.connect();
        echo.connector.releaseClient();
        expect(listenerCount(client.connection)).toBe(0);
        expect(connector).not.toBe(echo.connector);
        expect(client.close).not.toHaveBeenCalled();
    });

    test("10: connect() called again re-binds the callbacks to the new client and emits its status", () => {
        const { connector, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        const next = makeEchoClient();
        vi.mocked(AblyDevice.createClient).mockReturnValueOnce(next);

        connector.connect();
        expect(connector.ably).toBe(next);
        expect(seen).toEqual(["connecting"]); // a new client has not connected yet: not `reconnecting`

        connection.transition("connected"); // the old client: ignored
        next.connection.transition("connecting");
        next.connection.transition("disconnected");
        connectFully(next.connection, "key-2");
        expect(seen).toEqual(["connecting", "connected"]);
    });

    test("10: connect() called again with the same options.client keeps `connected before`", () => {
        const { connector, connection } = echoWithSuppliedClient();
        connectFully(connection);
        connection.transition("disconnected");
        const { seen } = record(connector);
        connector.connect();
        expect(seen).toEqual(["reconnecting"]);
    });

    test("Echo.disconnect() reports disconnected", () => {
        const { echo, connector, connection } = echoWithClient();
        connectFully(connection);
        const { seen } = record(connector);
        echo.disconnect();
        expect(seen).toEqual(["disconnected"]);
    });
});

describe("11: Echo.onConnectionChange() (P-03 registry)", () => {
    test("subscribe and unsubscribe", () => {
        const { echo, connection } = echoWithClient();
        const seen: ConnectionStatus[] = [];
        const off = echo.onConnectionChange((status) => seen.push(status));
        expect(seen).toEqual([]); // not called on subscribe
        connectFully(connection);
        off();
        connection.transition("disconnected");
        expect(seen).toEqual(["connected"]);
    });

    test("Echo.connect(): one emission with the new connector's status, then its updates; the old one is silent", () => {
        const {
            echo,
            connector: old,
            connection: oldConnection,
        } = echoWithClient();
        connectFully(oldConnection);
        const seen: ConnectionStatus[] = [];
        echo.onConnectionChange((status) => seen.push(status));
        const next = makeEchoClient();
        vi.mocked(AblyDevice.createClient).mockReturnValueOnce(next);

        echo.connect();
        expect(echo.connector).not.toBe(old);
        expect(seen).toEqual(["connecting"]); // emit-on-rebind; the old client's close is not reported

        oldConnection.transition("connected");
        connectFully(next.connection, "key-2");
        expect(seen).toEqual(["connecting", "connected"]);
    });

    test("the registry survives several Echo.connect() calls without duplicate listeners", () => {
        const { echo } = echoWithClient();
        const seen: ConnectionStatus[] = [];
        echo.onConnectionChange((status) => seen.push(status));
        const clients = [makeEchoClient(), makeEchoClient()];
        clients.forEach((client) => {
            vi.mocked(AblyDevice.createClient).mockReturnValueOnce(client);
            echo.connect();
        });
        connectFully(clients[1].connection);
        expect(seen).toEqual(["connecting", "connecting", "connected"]);
    });

    test("no subscriber: Echo.connect() emits nothing and binds nothing", () => {
        const { echo } = echoWithClient();
        const spy = vi.spyOn(AblyConnector.prototype, "onConnectionChange");
        echo.connect();
        expect(spy).not.toHaveBeenCalled();
    });

    test("the last unsubscribe unbinds Echo from the connector; a new subscribe binds again", () => {
        const { echo, connection } = echoWithClient();
        const statusListeners = () =>
            (echo.connector as any).statusListeners?.size ?? 0;
        const offA = echo.onConnectionChange(() => undefined);
        const offB = echo.onConnectionChange(() => undefined);
        expect(statusListeners()).toBe(1); // one bridge for every registry callback
        offA();
        expect(statusListeners()).toBe(1);
        offB();
        expect(statusListeners()).toBe(0);
        const seen: ConnectionStatus[] = [];
        echo.onConnectionChange((status) => seen.push(status));
        connectFully(connection);
        expect(seen).toEqual(["connected"]);
    });

    test("a throwing callback does not stop the others", () => {
        const error = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        const { echo, connection } = echoWithClient();
        const boom = new Error("boom");
        echo.onConnectionChange(() => {
            throw boom;
        });
        const seen: ConnectionStatus[] = [];
        echo.onConnectionChange((status) => seen.push(status));
        connectFully(connection);
        echo.connect(); // the emit-on-rebind is isolated too
        expect(seen).toEqual(["connected", "connecting"]);
        expect(error).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledWith(boom);
    });

    test("works with any connector: a custom connector class", () => {
        const emitters: Array<(status: ConnectionStatus) => void> = [];
        class StatusConnector extends NullConnector {
            connectionStatus(): ConnectionStatus {
                return "connected";
            }
            onConnectionChange(
                callback: (status: ConnectionStatus) => void,
            ): () => void {
                emitters.push(callback);
                return () => emitters.splice(emitters.indexOf(callback), 1);
            }
        }
        const echo = new Echo({
            broadcaster: StatusConnector,
            withoutInterceptors: true,
        } as any);
        const seen: ConnectionStatus[] = [];
        echo.onConnectionChange((status) => seen.push(status));
        expect(emitters).toHaveLength(1);
        emitters[0]("reconnecting");
        echo.connect();
        expect(emitters).toHaveLength(1); // the old connector's subscription was removed
        emitters[0]("failed");
        expect(seen).toEqual(["reconnecting", "connected", "failed"]);
    });
});

describe("socketId() (F-064, F-204)", () => {
    test("is undefined until the connection has a key", () => {
        const { echo, connection } = echoWithClient();
        expect(echo.socketId()).toBeUndefined();
        connection.transition("connecting");
        expect(echo.connector.socketId()).toBeUndefined();
        connection.key = "key-1";
        connection.transition("connected");
        expect(typeof echo.socketId()).toBe("string");
    });

    test("is undefined, not a TypeError, without a client", () => {
        expect(AblyConnector.prototype.socketId.call({})).toBeUndefined();
        expect(
            AblyConnector.prototype.socketId.call({ ably: {} }),
        ).toBeUndefined();
    });

    test("once connected: base64url JSON {connectionKey, clientId}", () => {
        const { echo, client, connection } = echoWithClient();
        connectFully(connection, "abc!def-1");
        const decode = () => JSON.parse(fromBase64UrlEncoded(echo.socketId()!));
        expect(echo.socketId()).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decode()).toEqual({
            connectionKey: "abc!def-1",
            clientId: null,
        });
        client.auth.clientId = "user-1";
        expect(decode()).toEqual({
            connectionKey: "abc!def-1",
            clientId: "user-1",
        });
    });

    test("the type is upstream's string | undefined", () => {
        expectTypeOf<ReturnType<AblyConnector["socketId"]>>().toEqualTypeOf<
            string | undefined
        >();
    });
});
