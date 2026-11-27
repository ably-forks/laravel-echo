import { describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
/**
 * Phase 07 (P-02, provisional): `broadcaster` is optional and defaults to `"ably"`, the native Ably connector. An
 * explicit broadcaster keeps working for every driver and for a custom connector class, an unknown value still
 * throws, and the caller's options object is never mutated. No network: autoConnect is off and tokens come from a
 * requestTokenFn stub; the other drivers get fake clients.
 */
import Echo, { type EchoOptions } from "../../src/echo";
import {
    AblyConnector,
    MercureConnector,
    NullConnector,
    PusherConnector,
    SocketIoConnector,
} from "../../src/connector";

const requestTokenFn = async () => ({ token: "" });
const offline = {
    withoutInterceptors: true,
    autoConnect: false,
    requestTokenFn,
};

class FakePusher {
    connection = { bind: vi.fn(), unbind: vi.fn(), socket_id: undefined };
    disconnect = vi.fn();
    constructor(
        public key: unknown,
        public options: unknown,
    ) {}
}

const fakeIo = vi.fn(() => ({
    io: { on: vi.fn() },
    on: vi.fn(),
    disconnect: vi.fn(),
}));

class CustomConnector extends NullConnector {}

describe("the default broadcaster (P-02)", () => {
    test("1: no broadcaster creates the native Ably connector", () => {
        const echo = new Echo({ ...offline });
        expect(echo.connector).toBeInstanceOf(AblyConnector);
        expect(echo.options.broadcaster).toBe("ably");
        expect(echo.connector.options.broadcaster).toBe("ably");
        expect(echo.connector.ably.connection.state).toBe("initialized");
        echo.disconnect();
    });

    test("1: an authEndpoint-only config (the README shape) also gets Ably", () => {
        const echo = new Echo({
            authEndpoint: "/broadcasting/auth",
            withoutInterceptors: true,
            autoConnect: false,
        });
        expect(echo.connector).toBeInstanceOf(AblyConnector);
        expect(echo.connector.options.authEndpoint).toBe("/broadcasting/auth");
        echo.disconnect();
    });

    test("1: broadcaster: undefined or null also defaults to Ably", () => {
        const a = new Echo({ ...offline, broadcaster: undefined });
        const b = new Echo({ ...offline, broadcaster: null } as any);
        expect(a.connector).toBeInstanceOf(AblyConnector);
        expect(b.connector).toBeInstanceOf(AblyConnector);
        a.disconnect();
        b.disconnect();
    });

    test("2: broadcaster: 'ably' gives the same connector", () => {
        const echo = new Echo({ ...offline, broadcaster: "ably" });
        expect(echo.connector).toBeInstanceOf(AblyConnector);
        echo.disconnect();
    });

    test("6: the caller's options object is not mutated", () => {
        const callerOptions = { ...offline };
        const echo = new Echo(callerOptions);
        expect("broadcaster" in callerOptions).toBe(false);
        expect(echo.options).not.toBe(callerOptions);
        echo.connect();
        expect("broadcaster" in callerOptions).toBe(false);
        echo.disconnect();
    });

    test("an explicit broadcaster keeps upstream's behaviour: Echo keeps the caller's object", () => {
        const callerOptions = {
            broadcaster: "null" as const,
            withoutInterceptors: true,
        };
        const echo = new Echo(callerOptions);
        expect(echo.options).toBe(callerOptions);
    });

    test("7: Echo.connect() called again still uses Ably", () => {
        const echo = new Echo({ ...offline });
        const first = echo.connector;
        echo.connect();
        expect(echo.connector).not.toBe(first);
        expect(echo.connector).toBeInstanceOf(AblyConnector);
        echo.disconnect();
    });
});

describe("3: an explicit broadcaster overrides the default", () => {
    test("null", () => {
        expect(
            new Echo({ broadcaster: "null", withoutInterceptors: true })
                .connector,
        ).toBeInstanceOf(NullConnector);
    });

    test("pusher, with options.Pusher", () => {
        const echo = new Echo({
            broadcaster: "pusher",
            key: "app-key",
            Pusher: FakePusher as any,
            withoutInterceptors: true,
        });
        expect(echo.connector).toBeInstanceOf(PusherConnector);
        expect(echo.connector.pusher).toBeInstanceOf(FakePusher);
    });

    test("reverb, with options.Pusher", () => {
        const echo = new Echo({
            broadcaster: "reverb",
            key: "app-key",
            Pusher: FakePusher as any,
            withoutInterceptors: true,
        });
        expect(echo.connector).toBeInstanceOf(PusherConnector);
        expect(echo.connector.options.cluster).toBe("");
    });

    test("socket.io, with options.client", () => {
        const echo = new Echo({
            broadcaster: "socket.io",
            client: fakeIo as any,
            host: "http://localhost:6001",
            withoutInterceptors: true,
        });
        expect(echo.connector).toBeInstanceOf(SocketIoConnector);
        expect(fakeIo).toHaveBeenCalled();
    });

    test("mercure", () => {
        const echo = new Echo({
            broadcaster: "mercure",
            host: "https://hub.example.com/.well-known/mercure",
            withoutInterceptors: true,
        });
        expect(echo.connector).toBeInstanceOf(MercureConnector);
        echo.disconnect();
    });

    test("a custom connector class", () => {
        const echo = new Echo({
            broadcaster: CustomConnector,
            withoutInterceptors: true,
        });
        expect(echo.connector).toBeInstanceOf(CustomConnector);
    });
});

describe("unknown values still throw", () => {
    test("4: an unknown string", () => {
        expect(
            // @ts-expect-error not a broadcaster
            () => new Echo({ broadcaster: "nope", withoutInterceptors: true }),
        ).toThrow("Broadcaster string nope is not supported.");
    });

    test("5: an empty string is not defaulted (`??`, not `||`)", () => {
        expect(
            // @ts-expect-error not a broadcaster
            () => new Echo({ broadcaster: "", withoutInterceptors: true }),
        ).toThrow("Broadcaster string  is not supported.");
    });
});

describe("8: types", () => {
    test("omitting broadcaster infers Echo<'ably'>, with the Ably connector", () => {
        const echo = new Echo({ ...offline });
        expectTypeOf(echo).toEqualTypeOf<Echo<"ably">>();
        expectTypeOf(echo.connector).toEqualTypeOf<AblyConnector>();
        expectTypeOf<Echo>().toEqualTypeOf<Echo<"ably">>(); // the class's default type argument
        const options: EchoOptions<"ably"> = {
            authEndpoint: "/broadcasting/auth",
        };
        expectTypeOf(new Echo(options)).toEqualTypeOf<Echo<"ably">>();
        echo.disconnect();
    });

    test("P07-01: echo.options.broadcaster reads non-optional, as upstream; the EchoOptions alias stays optional", () => {
        const echo = new Echo({ ...offline });
        expectTypeOf(echo.options.broadcaster).toEqualTypeOf<"ably">();
        expectTypeOf(
            new Echo({ broadcaster: "null", withoutInterceptors: true }).options
                .broadcaster,
        ).toEqualTypeOf<"null">();
        expectTypeOf<EchoOptions<"ably">["broadcaster"]>().toEqualTypeOf<
            "ably" | undefined
        >(); // residual: a type-level read of the alias (the write side is additive)
        expect(echo.options.broadcaster).toBe("ably");
        echo.disconnect();
    });

    test("an explicit broadcaster still infers its driver", () => {
        expectTypeOf(
            new Echo({ broadcaster: "null", withoutInterceptors: true }),
        ).toEqualTypeOf<Echo<"null">>();
        expectTypeOf(
            new Echo({
                broadcaster: "pusher",
                Pusher: FakePusher as any,
                withoutInterceptors: true,
            }).connector,
        ).toEqualTypeOf<PusherConnector<"pusher">>();
    });

    test("caveat: an explicit `broadcaster: undefined` infers the keyof Broadcaster union (types only)", () => {
        const echo = new Echo({ ...offline, broadcaster: undefined });
        expectTypeOf(echo).not.toEqualTypeOf<Echo<"ably">>();
        expect(echo.connector).toBeInstanceOf(AblyConnector); // the runtime default is still Ably
        echo.disconnect();
    });
});
