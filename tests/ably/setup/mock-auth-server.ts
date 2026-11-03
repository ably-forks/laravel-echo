import { isNullOrUndefinedOrEmpty, parseJwt, fromBase64UrlEncoded } from '../../../src/channel/ably/utils';
import * as Ably from 'ably';
import * as jwt from 'jsonwebtoken';

type channels = Array<string>;

/**
 * MockAuthServer mimicks {@link https://github.com/ably/laravel-broadcaster/blob/main/src/AblyBroadcaster.php AblyBroadcaster.php}.
 * Aim is to keep implementation and behaviour in sync with AblyBroadcaster.php, so that it can be tested
 * without running actual PHP server.
 */
export class MockAuthServer {
    keyName: string;
    keySecret: string;
    ablyClient: Ably.Rest;
    clientId: string | null = 'sacOO7@github.com';

    shortLived: channels;
    banned: channels;

    userInfo = { id: 'sacOO7@github.com', name: 'sacOO7' }; // Used for presence

    constructor(apiKey: string, endpoint = 'nonprod:sandbox') {
        const keys = apiKey.split(':');
        this.keyName = keys[0];
        this.keySecret = keys[1];
        this.ablyClient = new Ably.Rest({ key: apiKey, endpoint });
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
        let capabilities = { 'public:*': ['subscribe', 'history', 'channel-metadata'] };
        let iat = 0;
        let exp = 0;
        let serverTime = await this.ablyClient.time();
        if (!isNullOrUndefinedOrEmpty(token) && !this.tokenInvalidOrExpired(serverTime, token)) {
            const { payload } = parseJwt(token);
            iat = payload.iat;
            exp = payload.exp;
            capabilities = JSON.parse(payload['x-ably-capability']);
        } else {
            iat = Math.round(serverTime / 1000);
            exp = iat + 60; /* time of expiration in seconds */
        }
        if (!isNullOrUndefinedOrEmpty(channelName)) {
            capabilities[channelName] = ['*'];
        }
        let claims = {
            iat,
            exp,
            'x-ably-clientId': this.clientId,
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
