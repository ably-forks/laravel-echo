import { vi, describe, test, expect, beforeEach } from "vite-plus/test";
/**
 * The sandbox suites' MockAuthServer mirrors laravel-broadcaster 2.0's guest client ids
 * (https://github.com/ably/laravel-broadcaster/pull/85). No network: the server time is stubbed, and getSignedToken only
 * signs JWTs.
 */
import { createHmac } from "crypto";
import * as jwt from "jsonwebtoken";
import { MockAuthServer } from "./setup/mock-auth-server";
import { parseJwt } from "../../src/channel/ably/utils";

const KEY_NAME = "appid.keyid";
const KEY_SECRET = "mock-auth-server-test-secret";
const GUEST_ID = /^guest:([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;

const clientIdOf = (response: { token: string }) =>
    parseJwt(response.token).payload["x-ably-clientId"] as string | null;

/** The broadcaster's tag, computed independently of the mock. */
const tagOf = (random: string, secret = KEY_SECRET) =>
    createHmac("sha256", secret)
        .update(`ably-guest:${random}`)
        .digest()
        .subarray(0, 16)
        .toString("base64url");

describe("MockAuthServer: guest client ids like laravel-broadcaster 2.0", () => {
    let server: MockAuthServer;
    let now: number;

    const sign = (payload: object, secret = KEY_SECRET) =>
        jwt.sign(payload, secret, {
            header: { typ: "JWT", alg: "HS256", kid: KEY_NAME },
        });
    const tokenFor = (clientId: string | null, exp = now / 1000 + 60) =>
        sign({
            iat: Math.round(now / 1000),
            exp: Math.round(exp),
            "x-ably-clientId": clientId,
            "x-ably-capability": JSON.stringify({ "public:*": ["subscribe"] }),
        });

    beforeEach(() => {
        server = new MockAuthServer(`${KEY_NAME}:${KEY_SECRET}`);
        server.clientId = null;
        now = Date.now();
        vi.spyOn(server.ablyClient, "time").mockImplementation(async () => now);
    });

    test("1. guest ids are always on: a guest gets guest:<random>.<HMAC tag>, never null", async () => {
        const clientId = clientIdOf(await server.getSignedToken());
        expect(clientId).not.toBeNull();
        expect(clientId).toMatch(GUEST_ID);
        const [, random, tag] = GUEST_ID.exec(clientId!)!;
        expect(tag).toBe(tagOf(random));
        expect(tag).not.toBe(tagOf(random, "another-secret"));
        // the guest prefix follows guestIdPrefix
        server.resetSession();
        server.guestIdPrefix = "visitor:";
        expect(clientIdOf(await server.getSignedToken())).toMatch(
            /^visitor:[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/,
        );
    });

    test("1. a guest is still denied private and presence channels (403)", async () => {
        for (const channel of ["private:a", "presence:a"]) {
            await expect(server.getSignedToken(channel)).rejects.toMatchObject({
                statusCode: 403,
            });
        }
    });

    test("2. stable per session: two guest token requests get the same clientId", async () => {
        const first = clientIdOf(await server.getSignedToken());
        const second = clientIdOf(await server.getSignedToken(null, null));
        const renewal = clientIdOf(
            await server.getSignedToken(null, tokenFor(first)),
        );
        expect(second).toBe(first);
        expect(renewal).toBe(first);
        expect(server.guestId).toBe(first);
    });

    describe("3. session-less: the presented token's guest id is reused only when it verifies", () => {
        let issued: string;

        beforeEach(() => {
            server.sessionless = true;
            issued = server.newGuestId();
        });

        const resolvedFor = async (token: string | null) =>
            clientIdOf(await server.getSignedToken(null, token));

        test("a valid presented guest token is reused", async () => {
            expect(await resolvedFor(tokenFor(issued))).toBe(issued);
            expect(server.guestId).toBeNull(); // nothing is stored
        });

        test("no presented token: a fresh guest id, not stored", async () => {
            const a = await resolvedFor(null);
            const b = await resolvedFor(null);
            expect(a).toMatch(GUEST_ID);
            expect(b).toMatch(GUEST_ID);
            expect(a).not.toBe(b);
            expect(server.guestId).toBeNull();
        });

        test("a tampered tag gets a fresh id", async () => {
            const last = issued.slice(-1) === "A" ? "B" : "A";
            const tampered = issued.slice(0, -1) + last;
            const resolved = await resolvedFor(tokenFor(tampered));
            expect(resolved).toMatch(GUEST_ID);
            expect(resolved).not.toBe(tampered);
            expect(resolved).not.toBe(issued);
        });

        test("a token with a bad signature gets a fresh id", async () => {
            const forged = sign(
                {
                    iat: Math.round(now / 1000),
                    exp: Math.round(now / 1000) + 60,
                    "x-ably-clientId": issued,
                    "x-ably-capability": "{}",
                },
                "another-secret",
            );
            const resolved = await resolvedFor(forged);
            expect(resolved).toMatch(GUEST_ID);
            expect(resolved).not.toBe(issued);
        });

        test("a guest id under another prefix gets a fresh id", async () => {
            server.guestIdPrefix = "other:"; // same length as guest:, so only the prefix check tells them apart
            const resolved = await resolvedFor(tokenFor(issued)); // issued under guest:
            expect(resolved).toMatch(/^other:/);
            expect(resolved).not.toBe(issued);
        });

        test("an expired token gets a fresh id", async () => {
            const resolved = await resolvedFor(
                tokenFor(issued, now / 1000 - 1),
            );
            expect(resolved).toMatch(GUEST_ID);
            expect(resolved).not.toBe(issued);
        });

        test("a user's token is not reused for a guest", async () => {
            const resolved = await resolvedFor(tokenFor("user1"));
            expect(resolved).toMatch(GUEST_ID);
        });
    });

    test("4. a signed-in request clears the stored guest id: the next guest gets a fresh one", async () => {
        const a = clientIdOf(await server.getSignedToken());
        expect(a).toMatch(GUEST_ID);

        server.clientId = "user1";
        expect(clientIdOf(await server.getSignedToken())).toBe("user1");
        expect(server.guestId).toBeNull();

        server.clientId = null;
        const b = clientIdOf(await server.getSignedToken());
        expect(b).toMatch(GUEST_ID);
        expect(b).not.toBe(a);
    });

    test("4. a stateless signed-in request leaves the session alone", async () => {
        const a = clientIdOf(await server.getSignedToken());
        server.sessionless = true;
        server.clientId = "user1";
        await server.getSignedToken();
        expect(server.guestId).toBe(a);
    });

    test("a stored id that is not a guest id of this key and prefix is replaced", async () => {
        server.session.guestId = "guest:not-a-valid-id";
        const clientId = clientIdOf(await server.getSignedToken());
        expect(clientId).toMatch(GUEST_ID);
        expect(server.guestId).toBe(clientId);
    });

    test("getSignedTokenWithoutGuestId models a custom endpoint: no user, no clientId", async () => {
        expect(clientIdOf(await server.getSignedTokenWithoutGuestId())).toBe(
            null,
        );
        expect(server.guestId).toBeNull();
        server.clientId = "user1";
        expect(clientIdOf(await server.getSignedTokenWithoutGuestId())).toBe(
            "user1",
        );
    });
});
