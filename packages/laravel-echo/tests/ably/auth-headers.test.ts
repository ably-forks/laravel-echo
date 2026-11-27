/**
 * AblyConnector.setOptions copies `auth` / `userAuthentication` and their headers (E-07, F-046): the bearer and CSRF
 * headers never land in the caller's object, in another connector, or in upstream's static `_defaultOptions`, so a
 * logout (`bearerToken = null` + `connect()`) or a second Echo instance cannot send a previous user's token.
 *
 * The cases of the 1.x patch's tests/ably/auth-headers.test.ts are ported here for the Ably connector. Its `null`
 * connector leg is not: v2 keeps upstream's Connector.setOptions for the other connectors (the fix lives in the
 * fork-only AblyConnector). No network: Ably runs on a fake client, except where AblyAuth is needed, and then
 * `fetch` is stubbed.
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import Echo from "../../src/echo";
import { AblyConnector, Connector } from "../../src/connector";
import { makeFakeAblyClient, makeJwt } from "../parity/fake-ably";

// any: the options are built per test, with the keys the case needs (as the 1.x test did)
const make = (extra: Record<string, any> = {}): any => ({
    broadcaster: "ably",
    withoutInterceptors: true,
    client: makeFakeAblyClient(),
    ...extra,
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("auth headers (ably connector)", () => {
    // ported from the 1.x test
    test("the caller's auth.headers and userAuthentication.headers are not mutated", () => {
        const opts = make({ auth: { headers: {} }, userAuthentication: { headers: {} }, bearerToken: "A" });
        const echo = new Echo(opts);

        expect(opts.auth.headers).toEqual({});
        expect(opts.userAuthentication.headers).toEqual({});
        expect(echo.connector.options.auth.headers.Authorization).toBe("Bearer A");
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBe("Bearer A");
        expect(echo.connector.options.auth.headers).not.toBe(opts.auth.headers);
        expect(echo.connector.options.userAuthentication.headers).not.toBe(opts.userAuthentication.headers);
    });

    // ported from the 1.x test
    test("csrfToken is written into the copy, not the caller object", () => {
        const opts = make({ auth: { headers: {} }, userAuthentication: { headers: {} }, csrfToken: "tok" });
        const echo = new Echo(opts);

        expect(opts.auth.headers).toEqual({});
        expect(opts.userAuthentication.headers).toEqual({});
        expect(echo.connector.options.auth.headers["X-CSRF-TOKEN"]).toBe("tok");
        expect(echo.connector.options.userAuthentication.headers["X-CSRF-TOKEN"]).toBe("tok");
    });

    // ported from the 1.x test
    test("logout (bearerToken = null, connect()) leaves no Authorization behind", () => {
        const opts = make({ auth: { headers: {} }, userAuthentication: { headers: {} }, bearerToken: "A" });
        const echo = new Echo(opts);
        expect(echo.connector.options.auth.headers.Authorization).toBe("Bearer A");

        echo.options.bearerToken = null;
        echo.connect();

        expect(echo.connector.options.auth.headers.Authorization).toBeUndefined();
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBeUndefined();
    });

    test("logout without an auth option leaves no Authorization behind either", () => {
        const echo = new Echo(make({ bearerToken: "A" }));
        expect(echo.connector.options.auth.headers.Authorization).toBe("Bearer A");

        echo.options.bearerToken = null;
        echo.connect();

        expect(echo.connector.options.auth.headers.Authorization).toBeUndefined();
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBeUndefined();
    });

    // ported from the 1.x test
    test("an explicit caller Authorization header is preserved", () => {
        const opts = make({
            auth: { headers: { Authorization: "Basic xyz" } },
            userAuthentication: { headers: { Authorization: "Basic xyz" } },
        });
        const echo = new Echo(opts);

        expect(echo.connector.options.auth.headers.Authorization).toBe("Basic xyz");
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBe("Basic xyz");
        expect(opts.auth.headers).toEqual({ Authorization: "Basic xyz" });
    });

    test("an explicit caller Authorization header plus bearerToken: the bearer wins, as in upstream (VC-02)", () => {
        const opts = make({
            auth: { headers: { Authorization: "Basic xyz", "X-A": "1" } },
            userAuthentication: { headers: { Authorization: "Basic xyz" } },
            bearerToken: "A",
        });
        const echo = new Echo(opts);

        expect(echo.connector.options.auth.headers).toEqual({ Authorization: "Bearer A", "X-A": "1" });
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBe("Bearer A");
        // the caller's objects are untouched
        expect(opts.auth.headers).toEqual({ Authorization: "Basic xyz", "X-A": "1" });
        expect(opts.userAuthentication.headers).toEqual({ Authorization: "Basic xyz" });

        // the same precedence as upstream's Connector.setOptions (here through the null connector, own options object)
        const upstream = new Echo({
            broadcaster: "null",
            withoutInterceptors: true,
            auth: { headers: { Authorization: "Basic xyz" } },
            userAuthentication: { endpoint: "/broadcasting/user-auth", headers: { Authorization: "Basic xyz" } },
            bearerToken: "A",
        });
        expect(upstream.connector.options.auth.headers.Authorization).toBe(
            echo.connector.options.auth.headers.Authorization,
        );
    });

    // ported from the 1.x test
    test("with no auth option the per-instance defaults still apply and are not shared", () => {
        const a = new Echo(make({ bearerToken: "A" }));
        const b = new Echo(make({ bearerToken: "B" }));

        expect(a.connector.options.auth.headers.Authorization).toBe("Bearer A");
        expect(a.connector.options.userAuthentication.headers.Authorization).toBe("Bearer A");
        expect(b.connector.options.auth.headers.Authorization).toBe("Bearer B");
        expect(a.connector.options.auth.headers).not.toBe(b.connector.options.auth.headers);
    });

    test("connector A with a bearer token, then B without: B has no Authorization (F-046)", () => {
        const a = new Echo(make({ bearerToken: "A" }));
        const b = new Echo(make());

        expect(a.connector.options.auth.headers.Authorization).toBe("Bearer A");
        expect(b.connector.options.auth.headers.Authorization).toBeUndefined();
        expect(b.connector.options.userAuthentication.headers.Authorization).toBeUndefined();
        expect(a.connector.options.auth.headers).not.toBe(b.connector.options.auth.headers);
        expect(a.connector.options.userAuthentication.headers).not.toBe(b.connector.options.userAuthentication.headers);
    });

    test("upstream's static default headers stay empty", () => {
        new Echo(make({ bearerToken: "A", csrfToken: "tok" }));

        expect(Connector._defaultOptions.auth.headers).toEqual({});
        expect(Connector._defaultOptions.userAuthentication.headers).toEqual({});
    });

    // ported from the 1.x test
    test("userAuthentication.endpoint defaults when userAuthentication is omitted", () => {
        const echo = new Echo(make({ auth: { headers: { "X-A": "1" } } }));

        expect(echo.connector.options.userAuthentication.endpoint).toBe("/broadcasting/user-auth");
        expect(echo.connector.options.auth.headers["X-A"]).toBe("1");
    });

    // ported from the 1.x test (F-308)
    test("auth given without headers gets the bearer and CSRF headers on the copy", () => {
        const opts = make({ auth: {}, bearerToken: "A", csrfToken: "tok" });
        const echo = new Echo(opts);

        expect(echo.connector.options.auth.headers.Authorization).toBe("Bearer A");
        expect(echo.connector.options.auth.headers["X-CSRF-TOKEN"]).toBe("tok");
        expect(opts.auth).toEqual({});
    });

    // ported from the 1.x test
    test("userAuthentication given without headers keeps its endpoint and gets headers", () => {
        const echo = new Echo(make({ userAuthentication: { endpoint: "/custom" }, bearerToken: "A" }));

        expect(echo.connector.options.userAuthentication.endpoint).toBe("/custom");
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBe("Bearer A");
    });
});

describe("the auth endpoint request (AblyAuth)", () => {
    const authEndpoint = "https://app.test/broadcasting/auth";

    const stubFetch = () => {
        const calls: { url: string; headers: Record<string, string> }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
                if (url !== authEndpoint) {
                    throw new Error("no network in this test"); // e.g. ably's time request
                }
                calls.push({ url, headers: init.headers });
                return new Response(JSON.stringify({ token: makeJwt() }), { status: 200 });
            }),
        );
        return calls;
    };

    // no options.client, so AblyAuth exists; autoConnect: false keeps the client offline
    const makeWithAuth = (extra: Record<string, unknown> = {}) =>
        new Echo({ broadcaster: "ably", withoutInterceptors: true, autoConnect: false, authEndpoint, ...extra });

    test("after logout, the token request carries no previous bearer", async () => {
        const calls = stubFetch();
        const echo = makeWithAuth({ bearerToken: "A" });
        echo.options.bearerToken = null;
        echo.connect();

        const connector = echo.connector as AblyConnector;
        await connector.ablyAuth!.requestToken("private:x", null);

        expect(calls).toHaveLength(1);
        expect(calls[0].headers.Authorization).toBeUndefined();
        echo.disconnect();
    });

    test("a second Echo instance without a bearer sends none", async () => {
        const calls = stubFetch();
        const first = makeWithAuth({ bearerToken: "A" });
        const second = makeWithAuth();

        await first.connector.ablyAuth!.requestToken("private:x", null);
        await second.connector.ablyAuth!.requestToken("private:x", null);

        expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer A", undefined]);
        expect(second.connector.ablyAuth!.authHeaders).toBe(second.connector.options.auth.headers);
        first.disconnect();
        second.disconnect();
    });
});
