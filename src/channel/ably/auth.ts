import { beforeChannelAttach } from './attach';
import { toTokenDetails, parseJwt, fullUrl, httpRequestAsync } from './utils';
import { SequentialAuthTokenRequestExecuter } from './token-request';
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
            try {
                const { token } = await this.authRequestExecuter.request(null);
                const tokenDetails = toTokenDetails(token);
                callback(null, tokenDetails);
            } catch (error) {
                callback(error, null);
            }
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
                'Content-Length': postData.length,
                ...this.authHeaders,
            },
            body: postData,
        };
        return await httpRequestAsync(postOptions);
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
        this.authRequestExecuter = new SequentialAuthTokenRequestExecuter(token, requestTokenFn ?? this.requestToken);
    }

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
                const tokenHasChannelCapability = capability.includes(`${channelName}"`);
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
                        { ...this.options, token: toTokenDetails(jwtToken) },
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

    allowReconnectOnUserLogin = () => {
        const ablyConnection = this.ablyClient().connection

        const connectionFailedCallback = stateChange => {
            if (stateChange.reason.code == 40102) { // 40102 denotes mismatched clientId
                ablyConnection.off(connectionFailedCallback);
                this.onClientIdChanged();
            }
        }
        ablyConnection.on('failed', connectionFailedCallback);
    }

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

    tryAuthorizeOnSameConnection = (authOptions?: AuthOptions, callback?: (error, TokenDetails) => void) => {
        this.ablyClient().auth
            .authorize(null, authOptions)
            .then((tokenDetails) => callback?.(null, tokenDetails))
            .catch((err) => callback?.(err, null));
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
                    { ...this.options, token: toTokenDetails(jwtToken) as any },
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
