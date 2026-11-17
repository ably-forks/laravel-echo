import { isNullOrUndefinedOrEmpty, parseJwt, fromBase64UrlEncoded, httpError } from '../../../src/channel/ably/utils';
import { createHttpClient, type PubSubHttpClient } from '@ably/pubsub-server';
import * as jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

type channels = Array<string>;

/**
 * MockAuthServer mimicks {@link https://github.com/ably/laravel-broadcaster/blob/main/src/AblyBroadcaster.php AblyBroadcaster.php}.
 * Aim is to keep implementation and behaviour in sync with AblyBroadcaster.php, so that it can be tested
 * without running actual PHP server. It mirrors laravel-broadcaster 1.1:
 * - `guestClientId` = `ABLY_MAU_ACCOUNT=true`: a request without a user (`clientId` null) is signed with a guest id
 *   `guest:<random>.<tag>`, stable until `rotateGuestId()` (the broadcaster issues a fresh one after logout);
 * - a connection renewal (`channel_name` null) with a valid token of the same clientId follows `renewalMode`:
 *   - 'reverify' (default, the fixed broadcaster): a fresh iat/exp, and the capability is the public claims plus the
 *     presented private:/presence: channels that are still allowed (see `revoke()`/`isAllowed`);
 *   - 'reuse' (the old broadcaster, laravel-broadcaster 1.0.8): the presented token's iat, exp and capability, so the
 *     renewed token is byte-identical and ably-js keeps asking for re-auth in the last 30 s (an AUTH loop, then 40142);
 * - a channel-auth request (`channel_name` set) adds that channel to the presented token's claims, as before;
 * - a presented token's claims are used only for the same clientId (identity-scoped claims);
 * - a channel that is revoked (`revoke()`, or `isAllowed` returning false) is denied with a 403 on a channel-auth
 *   request, and dropped from the capability on a renewal;
 * - private and presence channels are denied (403) when there is no user, also in guest-id mode.
 * Use a `tokenExpiry` of at least 30 s when testing renewals: Ably asks a connected client to re-authorize 30 s before
 * the token expires, so a token of 30 s or less is always inside that window and renews in a loop, by design, in both
 * modes. Short-TTL suites that rely on a renewal returning the same claims set `renewalMode = 'reuse'` explicitly.
 * It copies the broadcaster's behaviour, not its exact formats or checks. Known gaps:
 * - the guest id only looks like the broadcaster's (`guest:<random>.<tag>`); the tag is random, not an HMAC;
 * - a guest id changes only when a test calls `rotateGuestId()` (the broadcaster issues a fresh one per session and
 *   after logout);
 * - a requested channel is granted `['*']`, also for channels the broadcaster would not authorize;
 * - a presented token's signature is not verified (only its expiry and clientId).
 */
export class MockAuthServer {
    keyName: string;
    keySecret: string;
    ablyClient: PubSubHttpClient;
    clientId: string | null = 'sacOO7@github.com';

    shortLived: channels;
    banned: channels;

    userInfo = { id: 'sacOO7@github.com', name: 'sacOO7' }; // Used for presence

    tokenExpiry = 60; // seconds, mirrors AblyBroadcaster's `token_expiry` config; use >= 30 for renewal tests (see above)

    renewalMode: 'reuse' | 'reverify' = 'reverify'; // how a connection renewal (channel_name null) treats the presented token

    /** Guarded channels that are no longer authorized (a user lost access). */
    revoked = new Set<string>();
    /** Optional predicate: return false to deny a guarded channel. */
    isAllowedFn?: (channelName: string) => boolean;
    revoke = (channelName: string) => this.revoked.add(channelName);
    unrevoke = (channelName: string) => this.revoked.delete(channelName);
    isAllowed = (channelName: string) => !this.revoked.has(channelName) && (this.isAllowedFn?.(channelName) ?? true);

    publicCapability = ['subscribe', 'history', 'channel-metadata']; // operations granted on `public:*`; tests may widen it

    guestClientId = false; // mirrors laravel-broadcaster's ABLY_MAU_ACCOUNT / mau_account
    guestId = MockAuthServer.newGuestId();

    static newGuestId = () => `guest:${randomBytes(8).toString('hex')}.${randomBytes(4).toString('hex')}`;

    /** A fresh guest id, as the broadcaster issues after logout. */
    rotateGuestId = () => {
        this.guestId = MockAuthServer.newGuestId();
    };

    /** The clientId the next token is signed with: the user, else the guest id in guest-id mode, else null. */
    signedClientId = (): string | null => this.clientId ?? (this.guestClientId ? this.guestId : null);

    constructor(apiKey: string, endpoint = 'nonprod:sandbox') {
        const keys = apiKey.split(':');
        this.keyName = keys[0];
        this.keySecret = keys[1];
        this.ablyClient = createHttpClient({ key: apiKey, endpoint });
    }

    /**
     * Broadcast to all clients subscribed to given channel.
     */
    broadcast = async (channelName: string, eventName: string, message: string) => {
        await this.broadcastToOthers("", {channelName, eventName, payload: message});
    };

    /**
     * Broadcast on behalf of a given realtime client.
     */
    broadcastToOthers = async (socketId: string, {channelName, eventName, payload}) => {
        let protoMsg = {name: eventName, data: payload};
        if (!isNullOrUndefinedOrEmpty(socketId)) {
            const socketIdObj = JSON.parse(fromBase64UrlEncoded(socketId));
            protoMsg = {...protoMsg, ...socketIdObj}
        }
        await this.ablyClient.channels.get(channelName).publish(protoMsg);
    };

    tokenInvalidOrExpired = (serverTime, token) => {
        const tokenInvalid = false;
        const { payload } = parseJwt(token);
        return tokenInvalid || payload.exp * 1000 <= serverTime;
    };

    getSignedToken = async (channelName: any = null, token: any = null) => {
        const header = {
            typ: 'JWT',
            alg: 'HS256',
            kid: this.keyName,
        };
        // Set capabilities for public channel as per https://ably.com/docs/core-features/authentication#capability-operations
        let capabilities = { 'public:*': [...this.publicCapability] };
        let iat = 0;
        let exp = 0;
        if (this.clientId == null && !isNullOrUndefinedOrEmpty(channelName) && this.isGuardedChannel(channelName)) {
            // the broadcaster's AccessDeniedHttpException, as Echo's authEndpoint path reports it
            throw httpError(`HTTP 403: no user for ${channelName}`, 403, 40300);
        }
        if (!isNullOrUndefinedOrEmpty(channelName) && this.isGuardedChannel(channelName) && !this.isAllowed(channelName)) {
            throw httpError(`HTTP 403: access to ${channelName} is not allowed`, 403, 40300);
        }
        const clientId = this.signedClientId();
        let serverTime = await this.ablyClient.time();
        // identity-scoped claims: reuse a presented token's claims only when it was signed for the same clientId
        if (
            !isNullOrUndefinedOrEmpty(token) &&
            !this.tokenInvalidOrExpired(serverTime, token) &&
            (parseJwt(token).payload['x-ably-clientId'] ?? null) === clientId
        ) {
            const { payload } = parseJwt(token);
            const presented = JSON.parse(payload['x-ably-capability']);
            if (isNullOrUndefinedOrEmpty(channelName) && this.renewalMode === 'reverify') {
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
            capabilities[channelName] = ['*'];
        }
        let claims = {
            iat,
            exp,
            'x-ably-clientId': clientId,
            'x-ably-capability': JSON.stringify(capabilities),
        };
        claims = this.validateShortLivedOrBannedChannels(channelName, claims);
        const response = { token: jwt.sign(claims, this.keySecret, { header }) };
        if (channelName && this.isPresenceChannel(channelName)) {
            return { ...response, info: this.userInfo };
        }
        return response;
    };

    isPresenceChannel = (channelName) => channelName.startsWith('presence:');

    isGuardedChannel = (channelName) => channelName.startsWith('private:') || this.isPresenceChannel(channelName);

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
