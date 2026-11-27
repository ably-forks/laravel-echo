/**
 * The native Ably connector on upstream's generic API (Phase 03): the `ably` broadcaster is typed with the Ably
 * classes, and the fork-only API decisions keep their behaviour. No network: Ably runs on a fake client.
 */
import { describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import Echo, { type AblyOptions, type ChannelVisibility, type EchoOptions } from "../../src/echo";
import { AblyConnector } from "../../src/connector";
import { AblyChannel, AblyPresenceChannel, AblyPrivateChannel } from "../../src/channel";
import { makeFakeAblyClient } from "../parity/fake-ably";

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
