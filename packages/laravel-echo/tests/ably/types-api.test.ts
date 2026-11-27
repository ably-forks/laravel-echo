/**
 * The native Ably connector on upstream's generic API (Phase 03): the `ably` broadcaster is typed with the Ably
 * classes, and the fork-only API decisions keep their behaviour. No network: Ably runs on a fake client.
 */
import { describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import Echo, {
    Channel,
    Connector,
    type AblyOptions,
    type Broadcaster,
    type ChannelVisibility,
    type ConnectionStatus,
    type EchoOptions,
    type PresenceChannel,
} from "../../src/echo";
import {
    AblyConnector,
    MercureConnector,
    NullConnector,
    PusherConnector,
    SocketIoConnector,
    type AblyTokenResponse,
} from "../../src/connector";
import { AblyChannel, AblyPresenceChannel, AblyPrivateChannel } from "../../src/channel";
import type { PubSubClient } from "../../src/types/ably";
import type IifeEcho from "../../src/index.iife";
import { FakeEmitter, makeFakeAblyClient } from "../parity/fake-ably";

// fake-ably.ts calls the Jest global until Phase 04 ports it to Vitest; map it to `vi` meanwhile (a no-op after).
(globalThis as { jest?: unknown }).jest ??= vi;

const makeEcho = () =>
    new Echo({ broadcaster: "ably", client: makeFakeAblyClient(), withoutInterceptors: true });

describe("the ably broadcaster is typed with the Ably classes", () => {
    test("connector and channels", () => {
        const echo = makeEcho();

        expectTypeOf(echo.connector).toEqualTypeOf<AblyConnector>();
        expectTypeOf(echo.channel("x")).toEqualTypeOf<AblyChannel>();
        expectTypeOf(echo.private("x")).toEqualTypeOf<AblyPrivateChannel>();
        expectTypeOf(echo.join("x")).toEqualTypeOf<AblyPresenceChannel>();
        expectTypeOf(echo.encryptedPrivate).returns.toBeNever();

        expect(echo.connector).toBeInstanceOf(AblyConnector);
        expect(echo.channel("x")).toBeInstanceOf(AblyChannel);
        expect(echo.private("x")).toBeInstanceOf(AblyPrivateChannel);
        expect(echo.join("x")).toBeInstanceOf(AblyPresenceChannel);
    });

    test("chaining methods return the channel's own type", () => {
        const echo = makeEcho();
        const presence = echo.join("room");
        const callback = () => undefined;

        expectTypeOf(presence.here(callback)).toEqualTypeOf<AblyPresenceChannel>();
        expectTypeOf(presence.listen(".e", callback).joining(callback)).toEqualTypeOf<AblyPresenceChannel>();
        expectTypeOf(echo.private("p").whisper("typing", { a: 1 })).toEqualTypeOf<AblyPrivateChannel>();
        expect(presence.listen(".e", callback).stopListening(".e", callback)).toBe(presence);
    });

    test("AblyOptions is exported and accepted as the ably options", () => {
        const options: AblyOptions = {
            ...({} as AblyOptions),
            requestTokenFn: async (channelName: string | null, existingToken: string | null) => ({
                token: `${channelName}:${existingToken}`,
            }),
            httpRequestTimeout: 5000,
        };
        expectTypeOf<Partial<AblyOptions>>().toMatchTypeOf<Partial<EchoOptions<"ably">>>();
        expectTypeOf(options.client).toEqualTypeOf<AblyOptions["client"]>();
    });
});

describe("encryptedPrivate() with the ably broadcaster (P-10)", () => {
    test("throws the Ably message, not the generic allow-list one", () => {
        const echo = makeEcho();

        expect(() => echo.encryptedPrivate("secret")).toThrow(
            new Error("Encrypted private channels are not supported with the Ably broadcaster"),
        );
        expect(echo.connector.channels).toEqual({});
    });

    test("other connectors outside the allow-list still get the generic message", () => {
        const fakeIo = () => ({ io: { on: () => undefined } });
        const echo = new Echo({ broadcaster: "socket.io", withoutInterceptors: true, client: fakeIo });

        expect(() => echo.encryptedPrivate("secret")).toThrow(
            "Broadcaster string socket.io does not support encrypted private channels.",
        );
    });
});

describe("visibility-aware leaveChannel() (P-04)", () => {
    test("with a visibility, the Ably connector gets its prefixed name", () => {
        const echo = makeEcho();
        const leaveChannel = vi.spyOn(echo.connector, "leaveChannel");

        echo.leaveChannel("orders", "private");
        echo.leaveChannel("orders", "presence");
        echo.leaveChannel("orders", "public");

        expect(leaveChannel.mock.calls).toEqual([["private:orders"], ["presence:orders"], ["public:orders"]]);
    });

    test("without a visibility, the name is passed through unchanged", () => {
        const echo = makeEcho();
        const leaveChannel = vi.spyOn(echo.connector, "leaveChannel");

        echo.leaveChannel("private:orders");

        expect(leaveChannel).toHaveBeenCalledExactlyOnceWith("private:orders");
    });

    test("leaves exactly the channel of that visibility", () => {
        const echo = makeEcho();
        echo.private("orders");
        echo.join("orders");

        echo.leaveChannel("orders", "private");

        expect(Object.keys(echo.connector.channels)).toEqual(["presence:orders"]);
    });

    test("leaveAllChannels() still passes the connector's full names", () => {
        const echo = makeEcho();
        echo.channel("a");
        echo.private("b");
        echo.join("c");

        echo.leaveAllChannels();

        expect(echo.connector.channels).toEqual({});
    });

    test("connectorChannelName() uses Pusher-style names for the other connectors", () => {
        const echo = new Echo({ broadcaster: "null", withoutInterceptors: true });
        const names = (["public", "private", "presence"] as ChannelVisibility[]).map((v) =>
            echo.connectorChannelName("orders", v),
        );

        expect(names).toEqual(["orders", "private-orders", "presence-orders"]);
    });

    test("connectorChannelName() uses the Ably namespaces for the Ably connector", () => {
        const echo = makeEcho();

        expect(echo.connectorChannelName("orders", "private")).toBe("private:orders");
        expect(echo.connectorChannelName("orders", "public")).toBe("public:orders");
    });
});

// Every connector, built offline: Ably and Pusher on stub clients, Socket.IO on a stub `io`, Mercure without a
// connection (it opens its EventSource lazily), Null as is.
const fakeIo = () => ({ io: { on: () => undefined } });
const echoes = {
    ably: () => makeEcho(),
    reverb: () => new Echo({ broadcaster: "reverb", key: "k", client: {}, withoutInterceptors: true }),
    pusher: () => new Echo({ broadcaster: "pusher", key: "k", client: {}, withoutInterceptors: true }),
    "socket.io": () => new Echo({ broadcaster: "socket.io", client: fakeIo, withoutInterceptors: true }),
    null: () => new Echo({ broadcaster: "null", withoutInterceptors: true }),
    mercure: () =>
        new Echo({ broadcaster: "mercure", host: "https://hub.example.com/.well-known/mercure", withoutInterceptors: true }),
};
const nonAbly = (["reverb", "pusher", "socket.io", "null", "mercure"] as const).map((driver) => [driver] as const);
const visibilities: ChannelVisibility[] = ["public", "private", "presence"];

describe("UC-02: leaveChannel(channel, visibility?) for every connector", () => {
    test.each([
        ["public", "public:orders"],
        ["private", "private:orders"],
        ["presence", "presence:orders"],
    ] as const)("ably: visibility %s leaves %s", (visibility, fullName) => {
        const echo = makeEcho();
        const leaveChannel = vi.spyOn(echo.connector, "leaveChannel").mockImplementation(() => undefined);

        echo.leaveChannel("orders", visibility);

        expect(leaveChannel).toHaveBeenCalledExactlyOnceWith(fullName);
    });

    test.each([
        ["ably", "private:orders"],
        ["reverb", "private-orders"],
        ["pusher", "presence-orders"],
        ["socket.io", "orders"],
        ["null", "private-orders"],
        ["mercure", "private-encrypted-orders"],
    ] as const)("%s: the one-argument form passes %s through unchanged (upstream behaviour)", (driver, name) => {
        const echo = echoes[driver]();
        const leaveChannel = vi.spyOn(echo.connector, "leaveChannel").mockImplementation(() => undefined);

        echo.leaveChannel(name);

        expect(leaveChannel).toHaveBeenCalledExactlyOnceWith(name);
    });

    test.each(nonAbly)("%s: with a visibility, gets upstream's Pusher-style name", (driver) => {
        const echo = echoes[driver]();
        const leaveChannel = vi.spyOn(echo.connector, "leaveChannel").mockImplementation(() => undefined);

        visibilities.forEach((visibility) => echo.leaveChannel("orders", visibility));

        expect(leaveChannel.mock.calls).toEqual([["orders"], ["private-orders"], ["presence-orders"]]);
    });

    test("the real connectors accept the names they get (no throw, channel removed)", () => {
        const ably = makeEcho();
        ably.private("orders");
        expect(() => ably.leaveChannel("orders", "private")).not.toThrow();
        expect(ably.connector.channels).toEqual({});

        const mercure = echoes.mercure();
        expect(() => mercure.leaveChannel("orders", "presence")).not.toThrow();
        const nullEcho = echoes.null();
        expect(() => nullEcho.leaveChannel("orders", "private")).not.toThrow();
    });
});

describe("UC-03: connectorChannelName(name, visibility) for every connector", () => {
    test.each(visibilities)("ably: %s -> `${visibility}:${name}`", (visibility) => {
        expect(makeEcho().connectorChannelName("orders", visibility)).toBe(`${visibility}:orders`);
    });

    test.each(nonAbly)("%s: public -> bare, private -> private-, presence -> presence-", (driver) => {
        const echo = echoes[driver]();

        expect(visibilities.map((visibility) => echo.connectorChannelName("orders", visibility))).toEqual([
            "orders",
            "private-orders",
            "presence-orders",
        ]);
    });

    test("a custom connector class (broadcaster: Constructor) gets the Pusher-style names", () => {
        const echo = new Echo({ broadcaster: NullConnector, withoutInterceptors: true });

        expect(echo.connectorChannelName("orders", "presence")).toBe("presence-orders");
    });
});

describe("UC-04: encryptedPrivate() keeps upstream's guard for the other connectors", () => {
    test.each([["reverb"], ["pusher"], ["mercure"], ["null"]] as const)(
        "%s: allowed, delegates to connector.encryptedPrivateChannel(name)",
        (driver) => {
            const echo = echoes[driver]();
            const sentinel = {} as never;
            const spy = vi.spyOn(echo.connector, "encryptedPrivateChannel").mockReturnValue(sentinel);

            expect(echo.encryptedPrivate("orders")).toBe(sentinel);
            expect(spy).toHaveBeenCalledExactlyOnceWith("orders");
        },
    );

    test("null: the real call returns the Null encrypted channel", () => {
        const echo = echoes.null();

        expect(echo.encryptedPrivate("orders")).toBeInstanceOf(Channel);
    });

    test("socket.io: upstream's generic message", () => {
        expect(() => echoes["socket.io"]().encryptedPrivate("orders")).toThrow(
            "Broadcaster string socket.io does not support encrypted private channels.",
        );
    });

    test("a custom connector class outside the allow-list: upstream's generic message", () => {
        class Custom extends SocketIoConnector {} // not Pusher, Mercure or Null
        const echo = new Echo({ broadcaster: Custom, client: fakeIo, withoutInterceptors: true });

        expect(() => echo.encryptedPrivate("orders")).toThrow(
            /^Broadcaster function .*Custom.* does not support encrypted private channels\.$/s,
        );
    });

    test("ably: the Ably message, before the allow-list, and no channel is created", () => {
        const echo = makeEcho();
        const spy = vi.spyOn(echo.connector, "encryptedPrivateChannel");

        expect(() => echo.encryptedPrivate("orders")).toThrow(
            new Error("Encrypted private channels are not supported with the Ably broadcaster"),
        );
        expect(spy).toHaveBeenCalledOnce();
        expect(echo.connector.channels).toEqual({});
    });
});

describe("UC-05: the new type exports", () => {
    test("AblyOptions and ChannelVisibility resolve from the package root with the expected shapes", () => {
        expectTypeOf<ChannelVisibility>().toEqualTypeOf<"public" | "private" | "presence">();

        expectTypeOf<AblyOptions["client"]>().toEqualTypeOf<PubSubClient | undefined>();
        // Ably's own `token?: TokenDetails | string` intersected with Echo's `token?: string`: a string JWT
        expectTypeOf<AblyOptions["token"]>().toExtend<string | undefined>();
        expectTypeOf<"jwt">().toExtend<AblyOptions["token"]>();
        expectTypeOf<AblyOptions["httpRequestTimeout"]>().toEqualTypeOf<number | undefined>();
        expectTypeOf<NonNullable<AblyOptions["requestTokenFn"]>>().parameters.toEqualTypeOf<
            [channelName: string | null, existingToken: string | null]
        >();
        expectTypeOf<NonNullable<AblyOptions["requestTokenFn"]>>().returns.toEqualTypeOf<Promise<AblyTokenResponse>>();
        expectTypeOf<AblyTokenResponse>().toEqualTypeOf<{ token: string; info?: unknown }>();
        expectTypeOf<AblyOptions["broadcaster"]>().toEqualTypeOf<"ably">();
        // the upstream Echo options (EchoOptionsWithDefaults) are still part of it
        expectTypeOf<AblyOptions["authEndpoint"]>().toEqualTypeOf<string>();

        // the README's annotated requestTokenFn is accepted (method signature, bivariant parameters)
        const readme: Partial<AblyOptions> = {
            requestTokenFn: async (channelName: string, existingToken: string) => ({ token: channelName + existingToken }),
        };
        expect(readme.requestTokenFn).toBeTypeOf("function");
    });

    test("EchoOptions<'ably'> accepts the Ably options and the upstream generic ones", () => {
        const options: EchoOptions<"ably"> = {
            broadcaster: "ably",
            authEndpoint: "/broadcasting/auth",
            bearerToken: null,
            client: undefined,
            token: "jwt",
            httpRequestTimeout: 1000,
            endpoint: "nonprod:sandbox",
        };
        expectTypeOf(options).toExtend<Partial<AblyOptions>>();
    });

    test("the Ably classes are reachable from the root through Broadcaster['ably']", () => {
        expectTypeOf<Broadcaster["ably"]["connector"]>().toEqualTypeOf<AblyConnector>();
        expectTypeOf<Broadcaster["ably"]["public"]>().toEqualTypeOf<AblyChannel>();
        expectTypeOf<Broadcaster["ably"]["private"]>().toEqualTypeOf<AblyPrivateChannel>();
        expectTypeOf<Broadcaster["ably"]["presence"]>().toEqualTypeOf<AblyPresenceChannel>();
        expectTypeOf<Broadcaster["ably"]["encrypted"]>().toBeNever();
        expectTypeOf<Broadcaster["ably"]["options"]>().toExtend<Partial<AblyOptions>>();
        // upstream's other entries are unchanged
        expectTypeOf<Broadcaster["pusher"]["connector"]>().toEqualTypeOf<PusherConnector<"pusher">>();
        expectTypeOf<Broadcaster["reverb"]["connector"]>().toEqualTypeOf<PusherConnector<"reverb">>();
        expectTypeOf<Broadcaster["socket.io"]["connector"]>().toEqualTypeOf<SocketIoConnector>();
        expectTypeOf<Broadcaster["mercure"]["connector"]>().toEqualTypeOf<MercureConnector>();
        expectTypeOf<Broadcaster["null"]["connector"]>().toEqualTypeOf<NullConnector>();
    });

    test("the Ably classes have upstream's shapes", () => {
        expectTypeOf<AblyConnector>().toExtend<Connector<"ably", AblyChannel, AblyPrivateChannel, AblyPresenceChannel>>();
        expectTypeOf<AblyChannel>().toExtend<Channel>();
        expectTypeOf<AblyPrivateChannel>().toExtend<AblyChannel>();
        expectTypeOf<AblyPresenceChannel>().toExtend<PresenceChannel>();
        expectTypeOf<AblyConnector["options"]>().toEqualTypeOf<AblyOptions>();
        expectTypeOf<AblyConnector["ably"]>().toEqualTypeOf<PubSubClient>();
        expectTypeOf<AblyConnector["connectionStatus"]>().returns.toEqualTypeOf<ConnectionStatus>();
        expectTypeOf<AblyConnector["leaveChannel"]>().parameters.toEqualTypeOf<[name: string]>();
        expectTypeOf<AblyConnector["encryptedPrivateChannel"]>().returns.toBeNever();
        expectTypeOf<Echo<"ably">["leaveChannel"]>().parameters.toEqualTypeOf<
            [channel: string, visibility?: ChannelVisibility]
        >();
        expectTypeOf<Echo<"ably">["connectorChannelName"]>().toEqualTypeOf<
            (name: string, visibility: ChannelVisibility) => string
        >();
    });

    test("every chaining method of the Ably channels returns the channel's own type", () => {
        const cb = () => undefined;
        const echo = makeEcho();
        const pub = echo.channel("a");
        const priv = echo.private("b");
        const pres = echo.join("c");

        expectTypeOf(pub.listen(".e", cb).listenToAll(cb).stopListening(".e", cb).stopListeningToAll(cb)).toEqualTypeOf<AblyChannel>();
        expectTypeOf(pub.subscribed(cb).error(cb).unregisterSubscribed(cb).unregisterError(cb)).toEqualTypeOf<AblyChannel>();
        expectTypeOf(pub.notification(cb).stopListeningForNotification(cb)).toEqualTypeOf<AblyChannel>();
        expectTypeOf(priv.whisper("t", {}).listenForWhisper("t", cb)).toEqualTypeOf<AblyPrivateChannel>();
        expectTypeOf(pres.here(cb).joining(cb).leaving(cb).whisper("t", {})).toEqualTypeOf<AblyPresenceChannel>();
        expectTypeOf(pres.enter({}).update({}).leave({})).toEqualTypeOf<AblyPresenceChannel>();

        expect(pub.listen(".e", cb).stopListening(".e", cb)).toBe(pub);
        expect(pres.here(cb).joining(cb).leaving(cb)).toBe(pres);
    });

    test("the IIFE global's type has the class and upstream's namespace members (UC-06)", () => {
        expectTypeOf<typeof IifeEcho>().toExtend<typeof Echo>();
        expectTypeOf<(typeof IifeEcho)["default"]>().toEqualTypeOf<typeof Echo>();
        expectTypeOf<(typeof IifeEcho)["Channel"]>().toEqualTypeOf<typeof Channel>();
        expectTypeOf<(typeof IifeEcho)["Connector"]>().toEqualTypeOf<typeof Connector>();
        // runtime: Phase 04's bundles test and notes/p03-uc06-probe.txt (dist/echo.iife.js in a vm)
    });
});

describe("AblyConnector.connectionStatus() / onConnectionChange() (temporary stubs until Phase 06)", () => {
    const makeWithConnection = () => {
        const client = makeFakeAblyClient();
        client.connection = Object.assign(new FakeEmitter(), { state: "initialized" });
        const echo = new Echo({ broadcaster: "ably", client, withoutInterceptors: true });
        return { echo, connection: client.connection };
    };

    test.each([
        ["initialized", "connecting"],
        ["connecting", "connecting"],
        ["connected", "connected"],
        ["disconnected", "disconnected"],
        ["suspended", "disconnected"],
        ["closing", "disconnected"],
        ["closed", "disconnected"],
        ["failed", "failed"],
    ] as const)("ably state %s -> %s", (state, status) => {
        const { echo, connection } = makeWithConnection();
        connection.state = state;

        expect(echo.connector.connectionStatus()).toBe(status);
        expect(echo.connectionStatus()).toBe(status);
    });

    test("onConnectionChange() reports each change and its unsubscribe stops it", () => {
        const { echo, connection } = makeWithConnection();
        const seen: ConnectionStatus[] = [];

        const off = echo.connector.onConnectionChange((status) => seen.push(status));
        connection.state = "connected";
        connection.emit("connected", { current: "connected" });
        off();
        connection.state = "failed";
        connection.emit("failed", { current: "failed" });

        expect(seen).toEqual(["connected"]);
    });
});
