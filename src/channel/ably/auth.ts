import { beforeChannelAttach } from './attach';
import {
    toTokenDetails,
    parseJwt,
    fullUrl,
    httpRequestAsync,
    HTTP_REQUEST_TIMEOUT_MS,
    beginIdentitySwitch,
    endIdentitySwitch,
} from './utils';
import { SequentialAuthTokenRequestExecuter, TOKEN_REQUEST_TIMEOUT_MS } from './token-request';
import type { AblyChannel } from '../ably-channel';
import { AblyConnector } from '../../connector/ably-connector';
import { AblyPresenceChannel } from '../ably-presence-channel';
import type { AblyRealtime, AuthOptions, ChannelStateChange, ClientOptions, TokenDetails } from '../../../typings/ably';

export class AblyAuth {
    authEndpoint: string;
    authHeaders: any;
    authRequestExecuter: SequentialAuthTokenRequestExecuter;
    ablyConnector: AblyConnector;

    expiredAuthChannels = new Set<string>();
    setExpired = (channelName: string) => this.expiredAuthChannels.add(channelName);
    isExpired = (channelName: string) => this.expiredAuthChannels.has(channelName);
    removeExpired = (channelName: string) => this.expiredAuthChannels.delete(channelName);

    options: AuthOptions & Pick<ClientOptions, 'echoMessages'> = {
        queryTime: true,
        useTokenAuth: true,
        authCallback: async (_, callback) => {
            let tokenDetails;
            try {
                const { token } = await this.authRequestExecuter.request(null);
                tokenDetails = toTokenDetails(token);
            } catch (error) {
                callback(error, null);
                return;
            }
            callback(null, tokenDetails);
        },
        echoMessages: false, // https://docs.ably.io/client-lib-development-guide/features/#TO3h
    };

    requestToken = async (channelName: string, existingToken: string) => {
        let postData = JSON.stringify({ channel_name: channelName, token: existingToken });
        let postOptions = {
            uri: this.authEndpoint,
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                ...this.authHeaders,
            },
            body: postData,
        };
        // the token itself is validated by SequentialAuthTokenRequestExecuter (R12), for both sources
        return httpRequestAsync(postOptions, this.httpRequestTimeout());
    };

    constructor(ablyConnector: AblyConnector, options) {
        this.ablyConnector = ablyConnector;
        const {
            authEndpoint,
            auth: { headers },
            token,
            requestTokenFn,
        } = options;
        this.authEndpoint = fullUrl(authEndpoint);
        this.authHeaders = headers;
        this.authRequestExecuter = new SequentialAuthTokenRequestExecuter(token, requestTokenFn ?? this.requestToken, {
            source: requestTokenFn ? 'requestTokenFn' : `Auth endpoint ${this.authEndpoint}`,
            // T6 queue bound. authEndpoint: never shorter than the fetch timeout (R21), so the fetch's own 50003 always
            // wins and a large httpRequestTimeout is not silently capped by the queue. A user requestTokenFn does not
            // use httpRequestTimeout, so it gets the fixed token request timeout.
            timeoutMs: requestTokenFn
                ? TOKEN_REQUEST_TIMEOUT_MS
                : Math.max(TOKEN_REQUEST_TIMEOUT_MS, this.httpRequestTimeout() + 1000),
        });
    }

    httpRequestTimeout = (): number => this.ablyConnector.options?.httpRequestTimeout ?? HTTP_REQUEST_TIMEOUT_MS;

    ablyClient = () => this.ablyConnector.ably as AblyRealtime | any;

    existingToken = () => this.ablyClient().auth.tokenDetails as TokenDetails;

    getChannel = name => this.ablyConnector.channels[name];

    enableAuthorizeBeforeChannelAttach = () => {
        const ablyClient = this.ablyClient()
        ablyClient.getTimestamp(this.options.queryTime).catch(() => void 0); // generates serverTimeOffset in the background

        beforeChannelAttach(ablyClient, (realtimeChannel, errorCallback) => {
            const channelName = realtimeChannel.name;
            if (channelName.startsWith('public:')) {
                errorCallback(null);
                return;
            }

            // Use cached token if has channel capability and is not expired
            const tokenDetails = this.existingToken();
            if (tokenDetails && !this.isExpired(channelName)) {
                const capability = parseJwt(tokenDetails.token).payload['x-ably-capability'];
                // review §8.3: the channel must be a key of the capability, not a substring of its JSON
                let tokenHasChannelCapability = false;
                try {
                    tokenHasChannelCapability = Object.prototype.hasOwnProperty.call(JSON.parse(capability), channelName);
                } catch (e) {
                    tokenHasChannelCapability = false; // invalid capability JSON: request a new token
                }

                // checks with server time using offset, otherwise local time
                if (tokenHasChannelCapability && tokenDetails.expires > ablyClient.getTimestampUsingOffset()) {
                    errorCallback(null);
                    return;
                }
            }

            // explicitly request token for given channel name
            this.authRequestExecuter
                .request(channelName)
                .then(({ token: jwtToken, info }) => {
                    // get upgraded token with channel access
                    const echoChannel = this.getChannel(channelName);
                    this.setPresenceInfo(echoChannel, info);
                    this.tryAuthorizeOnSameConnection(
                        this.authOptionsForToken(jwtToken),
                        (err, _tokenDetails) => {
                            if (err) {
                                errorCallback(err);
                            } else {
                                this.removeExpired(channelName);
                                errorCallback(null);
                            }
                        }
                    );
                })
                .catch((err) => errorCallback(err));
        });
    };

    clientIdSwitchListeners: { failed: (stateChange?: any) => void; connected: () => void } | null = null;

    /**
     * 40102 = the server refused a clientId change on the live connection (or ably-js refused a token for another
     * identity). Reconnect once per failure episode: the handler is re-armed only by the next `connected`, so a
     * reconnect that fails again with 40102 before connecting (failed -> connecting -> failed) cannot loop.
     */
    allowReconnectOnUserLogin = () => {
        const connection = this.ablyClient().connection;
        let armed = true;
        const failed = (stateChange?: any) => {
            if (stateChange?.reason?.code !== 40102) {
                endIdentitySwitch(this.ablyClient()); // E3: a real failure ends the switch window
                return;
            }
            if (!armed) return;
            armed = false;
            this.onClientIdChanged();
        };
        const connected = () => {
            armed = true;
            endIdentitySwitch(this.ablyClient()); // E3: the switch is complete
        };
        connection.on('failed', failed);
        connection.on('connected', connected);
        this.clientIdSwitchListeners = { failed, connected };
    };

    releaseClientIdSwitchListeners = () => {
        if (!this.clientIdSwitchListeners) return;
        const client = this.ablyClient();
        client?.connection?.off('failed', this.clientIdSwitchListeners.failed);
        client?.connection?.off('connected', this.clientIdSwitchListeners.connected);
        if (client) endIdentitySwitch(client);
        this.clientIdSwitchListeners = null;
    };

    /**
     * This will be called when (guest)user logs in and new clientId is returned in the jwt token.
     * If client tries to authenticate with new clientId on same connection, ably server returns
     * error and connection goes into failed state.
     * See https://github.com/ably/laravel-broadcaster/issues/45 for more details.
     * There's a separate test case added for user login flow => ably-user-login.test.ts.
     */
    onClientIdChanged = () => {
        this.ablyClient().connect();
        setTimeout(() => {
            for (const ablyChannel of Object.values(this.ablyConnector.channels)) {
                ablyChannel.channel.attach().catch(ablyChannel._alertErrorListeners);
            }
        }, 0);
    }

    /**
     * AuthOptions for an in-band authorize() with a new Echo JWT. ably-js keeps the first non-null clientId on the
     * Auth object for the client's lifetime (RSA15c), so a token for a different identity would fail the client with
     * 40102 (403) on every reconnect. `clientId: null` (public AuthOptions) clears it: the server still rejects the
     * in-band AUTH with 40102 (401), and allowReconnectOnUserLogin's fresh connection adopts the new clientId.
     */
    authOptionsForToken = (jwtToken: string): AuthOptions => {
        const token = toTokenDetails(jwtToken);
        const current = this.ablyClient().auth.clientId; // undefined/null while anonymous
        const identityChanges = current != null && current !== (token.clientId ?? null);
        return identityChanges ? { ...this.options, token, clientId: null } : { ...this.options, token };
    };

    tryAuthorizeOnSameConnection = (authOptions?: AuthOptions, callback?: (error, TokenDetails) => void) => {
        const client = this.ablyClient();
        const token = authOptions?.token as TokenDetails;
        // E3: a token for another identity (including null -> user) opens the switch window before authorize(), since
        // a channel's 40102 can arrive before the connection's `failed`
        if (token && typeof token === 'object' && (token.clientId ?? null) !== (client.auth.clientId ?? null)) {
            beginIdentitySwitch(client);
        }
        client.auth
            .authorize(null, authOptions)
            .then(
                (tokenDetails) => callback?.(null, tokenDetails),
                (err) => callback?.(err, null)
            )
            .catch((e) => console.error('laravel-echo: unexpected error after authorize', e));
    }

    onChannelFailed = (echoAblyChannel: AblyChannel) => (stateChange: ChannelStateChange) => {
        // channel capability rejected https://help.ably.io/error/40160
        if (stateChange.reason?.code == 40160) {
            this.handleChannelAuthError(echoAblyChannel);
        }
    };

    handleChannelAuthError = (echoAblyChannel: AblyChannel) => {
        if ((echoAblyChannel as any).skipAuth) {
            return;
        }
        const channelName = echoAblyChannel.name;
        // get upgraded token with channel access
        this.authRequestExecuter
            .request(channelName)
            .then(({ token: jwtToken, info }) => {
                this.setPresenceInfo(echoAblyChannel, info);
                this.tryAuthorizeOnSameConnection(
                    this.authOptionsForToken(jwtToken) as any,
                    (err, _tokenDetails) => {
                        if (err) {
                            echoAblyChannel._alertErrorListeners(err);
                        } else {
                            (echoAblyChannel as any).skipAuth = true;
                            echoAblyChannel.channel.once('attached', () => {
                                (echoAblyChannel as any).skipAuth = false;
                            });
                            echoAblyChannel.channel.attach().catch(echoAblyChannel._alertErrorListeners);
                        }
                    }
                );
            })
            .catch((err) => echoAblyChannel._alertErrorListeners(err));
    };

    setPresenceInfo = (echoAblyChannel: AblyChannel, info: any) => {
        if (echoAblyChannel instanceof AblyPresenceChannel) {
            echoAblyChannel.presenceData = info;
        }
    };
}
