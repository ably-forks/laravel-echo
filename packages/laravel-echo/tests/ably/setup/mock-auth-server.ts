import {
    isNullOrUndefinedOrEmpty,
    parseJwt,
    fromBase64UrlEncoded,
    httpError,
} from "../../../src/channel/ably/utils";
import { createHttpClient, type PubSubHttpClient } from "@ably/pubsub-server";
import * as jwt from "jsonwebtoken";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

type channels = Array<string>;

/**
 * MockAuthServer mimicks {@link https://github.com/ably/laravel-broadcaster/blob/main/src/AblyBroadcaster.php AblyBroadcaster.php}.
 * Aim is to keep implementation and behaviour in sync with AblyBroadcaster.php, so that it can be tested
 * without running actual PHP server. It mirrors laravel-broadcaster 2.0
 * (https://github.com/ably/laravel-broadcaster/pull/85):
 * - guest client ids are always on: a request without a user (`clientId` null) is signed with a guest id
 *   `<guestIdPrefix><random>.<tag>` (default prefix `guest:`). `random` is 16 random bytes and `tag` the first 16 bytes of
 *   HMAC-SHA256(`ably-guest:` + random, keySecret), both base64url without padding (22 characters each);
 * - one instance models one browser session: the guest id is stored in `session` on the first guest request and reused
 *   while it is a guest id of this key under the current prefix;
 * - `sessionless` models a stateless route (or an expired session cookie): a guest request reuses the clientId of the
 *   presented token when that token's HS256 signature verifies against keySecret, it is unexpired and its clientId is a
 *   guest id of this key under the current prefix; otherwise it gets a fresh guest id, which is not stored;
 * - a request with a user clears the stored guest id (not in `sessionless` mode), so the next guest request (after a
 *   logout) gets a fresh one;
 * - a connection renewal (`channel_name` null) with a valid token of the same clientId follows `renewalMode`:
 *   - 'reverify' (default, the fixed broadcaster): a fresh iat/exp, and the capability is the public claims plus the
 *     presented private:/presence: channels that are still allowed (see `revoke()`/`isAllowed`);
 *   - 'reuse' (the old broadcaster, laravel-broadcaster 1.0.8): the presented token's iat, exp and capability, so the
 *     renewed token is byte-identical and ably-js keeps asking for re-auth in the last 30 s (an AUTH loop, then 40142);
 * - a channel-auth request (`channel_name` set) adds that channel to the presented token's claims, as before;
 * - a presented token's claims are used only for the same clientId (identity-scoped claims);
 * - a channel that is revoked (`revoke()`, or `isAllowed` returning false) is denied with a 403 on a channel-auth
 *   request, and dropped from the capability on a renewal;
 * - private and presence channels are denied (403) when there is no user: a guest gets public channels only.
 * `getSignedTokenWithoutGuestId` is not the broadcaster: it models a custom auth endpoint that signs a request without a
 * user with no clientId (the null-clientId paths Echo still supports, F-182).
 * Use a `tokenExpiry` of at least 30 s when testing renewals: Ably asks a connected client to re-authorize 30 s before
 * the token expires, so a token of 30 s or less is always inside that window and renews in a loop, by design, in both
 * modes. Short-TTL suites that rely on a renewal returning the same claims set `renewalMode = 'reuse'` explicitly.
 * It copies the broadcaster's behaviour, not its exact formats or checks. Known gaps:
 * - `resolveGuestClientIdUsing()` (an app's own guest id scheme) is not modelled;
 * - a signed-in user whose broadcast identifier is null is not modelled: the broadcaster lets that user through the
 *   private/presence checks, signs it with the guest id and keeps the stored guest id; here `clientId` null is always
 *   "no user" (no sandbox suite depends on that case);
 * - a requested channel is granted `['*']`, also for channels the broadcaster would not authorize;
 * - a presented token's signature is not verified when its claims are reused (only its expiry and clientId); it is
 *   verified for the session-less guest id reuse above.
 */
export class MockAuthServer {
    keyName: string;
    keySecret: string;
    ablyClient: PubSubHttpClient;
    clientId: string | null = "sacOO7@github.com";

    shortLived: channels;
    banned: channels;

    userInfo = { id: "sacOO7@github.com", name: "sacOO7" }; // Used for presence

    tokenExpiry = 60; // seconds, mirrors AblyBroadcaster's `token_expiry` config; use >= 30 for renewal tests (see above)

    renewalMode: "reuse" | "reverify" = "reverify"; // how a connection renewal (channel_name null) treats the presented token

    /** Guarded channels that are no longer authorized (a user lost access). */
    revoked = new Set<string>();
    /** Optional predicate: return false to deny a guarded channel. */
    isAllowedFn?: (channelName: string) => boolean;
    revoke = (channelName: string) => this.revoked.add(channelName);
    unrevoke = (channelName: string) => this.revoked.delete(channelName);
    isAllowed = (channelName: string) =>
        !this.revoked.has(channelName) &&
        (this.isAllowedFn?.(channelName) ?? true);

    publicCapability = ["subscribe", "history", "channel-metadata"]; // operations granted on `public:*`; tests may widen it

    /** Prefix of the guest ids, mirrors the broadcaster's `guest_id_prefix` config (default `guest:`). */
    guestIdPrefix = "guest:";

    /** Models a stateless auth route (or an expired session cookie): no guest id is stored or read from `session`. */
    sessionless = false;

    /** The browser session this instance models: the stored guest id (the broadcaster's `ably_guest_client_id`). */
    session: { guestId: string | null } = { guestId: null };

    /** The session's guest id: null until the first guest request, and after a request with a user. */
    get guestId(): string | null {
        return this.session.guestId;
    }

    /** A new browser session (no stored guest id). */
    resetSession = () => {
        this.session = { guestId: null };
    };

    /** Stores a fresh guest id in the session. Not needed for a logout: a request with a user clears the stored id. */
    rotateGuestId = () => {
        this.session.guestId = this.newGuestId();
    };

    /** base64url (no padding) of the first 16 bytes of HMAC-SHA256("ably-guest:" + random, keySecret): 22 characters. */
    guestIdTag = (random: string) =>
        createHmac("sha256", this.keySecret)
            .update(`ably-guest:${random}`)
            .digest()
            .subarray(0, 16)
            .toString("base64url");

    /** `<guestIdPrefix><random>.<tag>`: 16 random bytes, base64url without padding (22 characters), and the HMAC tag. */
    newGuestId = () => {
        const random = randomBytes(16).toString("base64url");
        return `${this.guestIdPrefix}${random}.${this.guestIdTag(random)}`;
    };

    /** Whether `clientId` is a guest id of this key under the current prefix (recognised by its tag). */
    isOwnGuestId = (clientId: unknown): clientId is string => {
        if (
            typeof clientId !== "string" ||
            !clientId.startsWith(this.guestIdPrefix)
        ) {
            return false;
        }
        const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(
            clientId.slice(this.guestIdPrefix.length),
        );
        if (!match) {
            return false;
        }
        const expected = Buffer.from(this.guestIdTag(match[1]));
        const actual = Buffer.from(match[2]);
        return (
            expected.length === actual.length &&
            timingSafeEqual(expected, actual)
        );
    };

    /** The presented token's clientId, if its HS256 signature verifies against keySecret and it is unexpired. */
    verifiedClientId = (token: unknown, serverTime: number): unknown => {
        if (typeof token !== "string" || token === "") {
            return undefined;
        }
        try {
            const payload = jwt.verify(token, this.keySecret, {
                algorithms: ["HS256"],
                clockTimestamp: Math.floor(serverTime / 1000),
            });
            if (
                typeof payload !== "object" ||
                typeof payload.exp !== "number"
            ) {
                return undefined;
            }
            return payload["x-ably-clientId"];
        } catch {
            return undefined; // bad signature, expired or malformed: not reused
        }
    };

    /** The clientId of a request without a user, as the broadcaster's resolveGuestClientId() (without a resolver). */
    resolveGuestId = (token: unknown, serverTime: number): string => {
        if (!this.sessionless) {
            if (!this.isOwnGuestId(this.session.guestId)) {
                this.session.guestId = this.newGuestId();
            }
            return this.session.guestId as string;
        }
        const presented = this.verifiedClientId(token, serverTime);
        return this.isOwnGuestId(presented) ? presented : this.newGuestId();
    };

    constructor(apiKey: string, endpoint = "nonprod:sandbox") {
        const keys = apiKey.split(":");
        this.keyName = keys[0];
        this.keySecret = keys[1];
        this.ablyClient = createHttpClient({ key: apiKey, endpoint });
    }

    /**
     * Broadcast to all clients subscribed to given channel.
     */
    broadcast = async (
        channelName: string,
        eventName: string,
        message: string,
    ) => {
        await this.broadcastToOthers("", {
            channelName,
            eventName,
            payload: message,
        });
    };

    /**
     * Broadcast on behalf of a given realtime client.
     */
    broadcastToOthers = async (
        socketId: string,
        {
            channelName,
            eventName,
            payload,
        }: { channelName: string; eventName: string; payload: unknown },
    ) => {
        let protoMsg = { name: eventName, data: payload };
        if (!isNullOrUndefinedOrEmpty(socketId)) {
            const socketIdObj = JSON.parse(fromBase64UrlEncoded(socketId));
            protoMsg = { ...protoMsg, ...socketIdObj };
        }
        await this.ablyClient.channels.get(channelName).publish(protoMsg);
    };

    tokenInvalidOrExpired = (serverTime: number, token: string) => {
        const tokenInvalid = false;
        const { payload } = parseJwt(token);
        return tokenInvalid || payload.exp * 1000 <= serverTime;
    };

    /** The broadcaster's auth response: a request without a user is signed with a guest id. */
    getSignedToken = (channelName: any = null, token: any = null) =>
        this.signToken(channelName, token, true);

    /** A custom auth endpoint (not laravel-broadcaster v2): a request without a user is signed with no clientId. */
    getSignedTokenWithoutGuestId = (
        channelName: any = null,
        token: any = null,
    ) => this.signToken(channelName, token, false);

    signToken = async (channelName: any, token: any, guestIds: boolean) => {
        if (this.clientId != null && !this.sessionless) {
            // a signed-in user ends the guest identity: the next guest request (after a logout) gets a fresh id
            this.session.guestId = null;
        }
        const header = {
            typ: "JWT",
            alg: "HS256",
            kid: this.keyName,
        };
        // Set capabilities for public channel as per https://ably.com/docs/core-features/authentication#capability-operations
        let capabilities: Record<string, string[]> = {
            "public:*": [...this.publicCapability],
        };
        let iat = 0;
        let exp = 0;
        if (
            this.clientId == null &&
            !isNullOrUndefinedOrEmpty(channelName) &&
            this.isGuardedChannel(channelName)
        ) {
            // the broadcaster's AccessDeniedHttpException, as Echo's authEndpoint path reports it
            throw httpError(`HTTP 403: no user for ${channelName}`, 403, 40300);
        }
        if (
            !isNullOrUndefinedOrEmpty(channelName) &&
            this.isGuardedChannel(channelName) &&
            !this.isAllowed(channelName)
        ) {
            throw httpError(
                `HTTP 403: access to ${channelName} is not allowed`,
                403,
                40300,
            );
        }
        let serverTime = await this.ablyClient.time();
        const clientId =
            this.clientId ??
            (guestIds ? this.resolveGuestId(token, serverTime) : null);
        // identity-scoped claims: reuse a presented token's claims only when it was signed for the same clientId
        if (
            !isNullOrUndefinedOrEmpty(token) &&
            !this.tokenInvalidOrExpired(serverTime, token) &&
            (parseJwt(token).payload["x-ably-clientId"] ?? null) === clientId
        ) {
            const { payload } = parseJwt(token);
            const presented = JSON.parse(payload["x-ably-capability"]);
            if (
                isNullOrUndefinedOrEmpty(channelName) &&
                this.renewalMode === "reverify"
            ) {
                // connection renewal: fresh lifetime; keep only the presented guarded channels that are still allowed
                iat = Math.round(serverTime / 1000);
                exp = iat + this.tokenExpiry;
                for (const name of Object.keys(presented)) {
                    if (this.isGuardedChannel(name) && this.isAllowed(name)) {
                        capabilities[name] = presented[name];
                    }
                }
            } else {
                iat = payload.iat;
                exp = payload.exp;
                capabilities = presented;
            }
        } else {
            iat = Math.round(serverTime / 1000);
            exp = iat + this.tokenExpiry; /* time of expiration in seconds */
        }
        if (!isNullOrUndefinedOrEmpty(channelName)) {
            capabilities[channelName] = ["*"];
        }
        let claims = {
            iat,
            exp,
            "x-ably-clientId": clientId,
            "x-ably-capability": JSON.stringify(capabilities),
        };
        claims = this.validateShortLivedOrBannedChannels(channelName, claims);
        const response = {
            token: jwt.sign(claims, this.keySecret, { header }),
        };
        if (channelName && this.isPresenceChannel(channelName)) {
            return { ...response, info: this.userInfo };
        }
        return response;
    };

    isPresenceChannel = (channelName: string) =>
        channelName.startsWith("presence:");

    isGuardedChannel = (channelName: string) =>
        channelName.startsWith("private:") ||
        this.isPresenceChannel(channelName);

    setAuthExceptions = (shortLived: channels = [], banned: channels = []) => {
        this.shortLived = shortLived;
        this.banned = banned;
    };

    validateShortLivedOrBannedChannels = (channelName: string, claims: any) => {
        if (this.shortLived?.includes(channelName)) {
            const exp = claims.iat + 3; // if channel is shortlived, token expiry set to 3 seconds
            return { ...claims, exp };
        }
        if (this.banned?.includes(channelName)) {
            throw new Error(`User can't be authenticated for ${channelName}`);
        }
        return claims;
    };
}
