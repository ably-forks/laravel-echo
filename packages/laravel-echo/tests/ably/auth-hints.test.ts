import {
    vi,
    describe,
    test,
    expect,
    beforeEach,
    afterEach,
    beforeAll,
    afterAll,
} from "vite-plus/test";
import type { MockInstance } from "vite-plus/test";
/**
 * Once-per-page developer hints on the token request (Phase 08, F-190, F-191):
 * - [provisional: P-08 (a)] the auth endpoint answers with a Pusher-protocol `{auth}` response instead of a token;
 * - the connection token request (no channel) is refused with HTTP 403.
 * Both go to console.warn once per page (module state), and the request fails exactly as before.
 */
import {
    createServer,
    type Server,
    type IncomingMessage,
    type ServerResponse,
} from "http";
import type { AddressInfo } from "net";
import { AblyAuth } from "../../src/channel/ably/auth";
import type {
    AblyConnector,
    AblyOptions,
} from "../../src/connector/ably-connector";
import {
    CONNECTION_TOKEN_REFUSED_HINT,
    PUSHER_PROTOCOL_RESPONSE_HINT,
    loggedAuthHints,
} from "../../src/channel/ably/token-request";

// the exact texts, duplicated on purpose (Phase 08 §8.4 and §8.5)
const P08_TEXT =
    '@ably/laravel-echo: the auth endpoint returned a Pusher-protocol response (`{auth: "key:signature"}`) instead of an Ably token. ' +
    "This response comes from Laravel's built-in `ably` broadcaster, which `@ably/laravel-echo` does not support; " +
    'install `ably/laravel-broadcaster` v2 on the server. See "Troubleshooting" in the README.';
const REFUSED_TEXT =
    "@ably/laravel-echo: the auth endpoint refused the connection token request (HTTP 403). " +
    "The most likely cause is that the server uses Laravel's built-in `ably` broadcaster, which refuses requests without a channel name; " +
    'install `ably/laravel-broadcaster` v2 (see "Troubleshooting" in the README). ' +
    "Other causes: a middleware on the broadcasting auth route denied the request, or the presented token could not be re-signed.";

describe("auth hints: Pusher-protocol response and connection token 403", () => {
    let server: Server;
    let baseUrl: string;
    let handler: (req: IncomingMessage, res: ServerResponse) => void;
    let warn: MockInstance;

    /** A fresh AblyAuth, as each new Echo connector creates (the hints are per page, not per connector). */
    const makeAuth = (echoOptions: Record<string, unknown> = {}) =>
        new AblyAuth(
            { options: {} } as unknown as AblyConnector,
            {
                authEndpoint: `${baseUrl}/broadcasting/auth`,
                auth: { headers: {} },
                ...echoOptions,
            } as unknown as AblyOptions,
        );
    const respond = (status: number, body: unknown) => {
        handler = (_req, res) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
        };
    };
    const warnings = () => warn.mock.calls.map(([message]) => message);

    beforeAll(async () => {
        server = createServer((req, res) => handler(req, res));
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    });
    beforeEach(() => {
        loggedAuthHints.clear(); // a new page
        warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
        warn.mockRestore();
    });

    test("the hint texts are exact", () => {
        expect(PUSHER_PROTOCOL_RESPONSE_HINT).toBe(P08_TEXT);
        expect(CONNECTION_TOKEN_REFUSED_HINT).toBe(REFUSED_TEXT);
    });

    test("a 403 on the connection token request logs the hint once, even for two failures; the error is unchanged", async () => {
        respond(403, { message: "This action is unauthorized." });
        const first: any = await makeAuth()
            .authRequestExecuter.request(null)
            .catch((e) => e);
        const second: any = await makeAuth() // another connector on the same page
            .authRequestExecuter.request(null)
            .catch((e) => e);
        for (const err of [first, second]) {
            expect(err).toMatchObject({ statusCode: 403, code: 40300 });
            expect(err.message).toContain("HTTP 403");
        }
        expect(warnings()).toEqual([REFUSED_TEXT]);
    });

    test("an empty channel name is the connection token request too", async () => {
        respond(403, {});
        await makeAuth()
            .requestToken("", null)
            .catch(() => undefined);
        expect(warnings()).toEqual([REFUSED_TEXT]);
    });

    test.each(["private:a", "presence:a"])(
        "a 403 on a %s channel request logs no hint (normal for guests)",
        async (channel) => {
            respond(403, { message: "no" });
            const err: any = await makeAuth()
                .authRequestExecuter.request(channel)
                .catch((e) => e);
            expect(err).toMatchObject({ statusCode: 403, code: 40300 });
            expect(warn).not.toHaveBeenCalled();
        },
    );

    test.each([401, 419, 500])(
        "HTTP %i on the connection token request logs no hint",
        async (status) => {
            respond(status, { message: "no" });
            await makeAuth()
                .authRequestExecuter.request(null)
                .catch(() => undefined);
            expect(warn).not.toHaveBeenCalled();
        },
    );

    test("[provisional: P-08 (a)] a {auth} 200 response logs the hint once; the request still fails as before", async () => {
        respond(200, { auth: "k:s" });
        const errors: any[] = [];
        for (const channel of [null, "private:a"]) {
            errors.push(
                await makeAuth()
                    .authRequestExecuter.request(channel)
                    .catch((e) => e),
            );
        }
        for (const err of errors) {
            expect(err).toMatchObject({ code: 50000, statusCode: 500 });
            expect(err.message).toContain(
                "returned a response without a token",
            );
        }
        expect(warnings()).toEqual([P08_TEXT]);
    });

    test("[provisional: P-08 (a)] a requestTokenFn resolving with {auth} logs the same hint (one validation for both sources)", async () => {
        const auth = makeAuth({
            requestTokenFn: async () => ({ auth: "k:s", channel_data: "{}" }),
        });
        const err: any = await auth.authRequestExecuter
            .request("presence:a")
            .catch((e) => e);
        expect(err).toMatchObject({ code: 50000 });
        expect(warnings()).toEqual([P08_TEXT]);
    });

    test.each([
        ["a valid token next to auth", { auth: "k:s", token: "a.b.c" }],
        ["no auth", {}],
        ["a non-string auth", { auth: 1 }],
        ["null", null],
    ])("no P-08 hint for %s", async (_name, body) => {
        respond(200, body);
        await makeAuth()
            .authRequestExecuter.request(null)
            .catch(() => undefined);
        expect(warn).not.toHaveBeenCalled();
    });
});
