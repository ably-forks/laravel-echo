import { beforeChannelAttach } from "./attach";
import {
    toTokenDetails,
    parseJwt,
    fullUrl,
    httpRequestAsync,
    HTTP_REQUEST_TIMEOUT_MS,
    beginIdentitySwitch,
    endIdentitySwitch,
    beginRenewalReattach,
    endRenewalReattach,
} from "./utils";
import {
    SequentialAuthTokenRequestExecuter,
    TOKEN_REQUEST_TIMEOUT_MS,
    CONNECTION_TOKEN_REFUSED_HINT,
    warnOnce,
} from "./token-request";
import type { AblyChannel } from "../ably-channel";
import type {
    AblyConnector,
    AblyOptions,
    AblyTokenResponse,
} from "../../connector/ably-connector";
import { AblyPresenceChannel } from "../ably-presence-channel";
import type {
    AblyRealtime,
    AuthOptions,
    ChannelStateChange,
    ClientOptions,
    ConnectionStateChange,
    ErrorInfo,
    TokenDetails,
} from "../../types/ably";

/** The internals of ably's client that AblyAuth uses; none of them is in ably's public types. */
type InternalAblyClient = AblyRealtime & {
    getTimestamp(queryTime?: boolean): Promise<number>;
    getTimestampUsingOffset(): number;
    auth: AblyRealtime["auth"] & {
        tokenDetails?: TokenDetails;
        authorize(
            tokenParams: null,
            authOptions?: AuthOptions,
        ): Promise<TokenDetails>;
    };
};

/** An Echo channel with the flag that stops a second 40160 re-authorize while one is in progress. */
type ReauthorizingChannel = AblyChannel & { skipAuth?: boolean };

/** Called once by tryAuthorizeOnSameConnection(): with the error, or with the new token details. */
type AuthorizeCallback = (
    error: ErrorInfo | Error | null,
    tokenDetails: TokenDetails | null,
) => void;

export class AblyAuth {
    authEndpoint: string;
    authHeaders: Record<string, string>;
    authRequestExecuter: SequentialAuthTokenRequestExecuter;
    ablyConnector: AblyConnector;

    expiredAuthChannels = new Set<string>();
    setExpired = (channelName: string) =>
        this.expiredAuthChannels.add(channelName);
    isExpired = (channelName: string) =>
        this.expiredAuthChannels.has(channelName);
    removeExpired = (channelName: string) =>
        this.expiredAuthChannels.delete(channelName);

    options: AuthOptions & Pick<ClientOptions, "echoMessages"> = {
        queryTime: true,
        useTokenAuth: true,
        authCallback: async (_, callback) => {
            const client = this.ablyClient(); // the client this token is for: Echo.connect() may replace it meanwhile
            const wasClosed = this.isClosedOrClosing(client);
            let tokenDetails: TokenDetails;
            try {
                const { token } = await this.authRequestExecuter.request(null);
                tokenDetails = toTokenDetails(token);
            } catch (error) {
                // an ErrorInfo from httpError(), or whatever a requestTokenFn rejected with (ably reads code/message)
                callback(error as ErrorInfo, null);
                return;
            }
            if (
                this.ablyClient() !== client ||
                (!wasClosed && this.isClosedOrClosing(client))
            ) {
                // Echo.disconnect() (or Echo.connect(), which replaces the client) ran while the token was requested:
                // handing it over would make ably-js open the closed connection again (RTC8c)
                callback(
                    "@ably/laravel-echo: the connection was closed while a token was requested",
                    null,
                );
                return;
            }
            this.switchIdentityOnRenewal(tokenDetails);
            callback(null, tokenDetails);
        },
        echoMessages: false, // https://docs.ably.io/client-lib-development-guide/features/#TO3h
    };

    /**
     * A renewed connection token can carry another identity than the client holds, for example after a logout or
     * login in another tab. ably-js keeps the first clientId (RSA15c), so it would fail the reconnect with a
     * client-side 40102 and stay disconnected, then failed. Switch the same way as the in-page path instead: open the
     * switch window (E3) and clear the cached clientId with an authorize() that carries the token itself, so no token
     * request is made and this authCallback is not re-entered. The connection then reconnects once as the new
     * identity, and the channels re-attach (private and presence ones re-authorize).
     * When no clientId is cached (null -> user) only the E3 window is opened:
     * ably-js handles that change itself.
     */
    switchIdentityOnRenewal = (token: TokenDetails) => {
        const client = this.ablyClient();
        const current = client?.auth?.clientId ?? null;
        const next = token.clientId ?? null;
        if (!client || current === next) {
            return;
        }
        if (current === null) {
            // null -> user: ably-js adopts the clientId itself, so no authorize() here. The server may still reject an
            // in-band AUTH with 40102 ("mismatched clientId"), which the channels see before the connection recovers:
            // open the same E3 window as the in-page login, so that transient 40102 does not reach error().
            // (the client's first token has no connection yet, so nothing can be rejected: no window)
            if (client.connection?.id) {
                beginIdentitySwitch(client);
            }
            return;
        }
        beginIdentitySwitch(client);
        beginRenewalReattach(client); // the transient 40160 of ably-js's own re-attach of private/presence channels
        // after the callback has returned: an authorize() while ably-js still waits for it aborts the connect attempt
        setTimeout(() => {
            if (
                this.ablyClient() !== client ||
                ["closing", "closed"].includes(client.connection.state)
            ) {
                return; // Echo.connect() replaced the client, or it was closed
            }
            client.auth
                .authorize(null, { ...this.options, token, clientId: null })
                .catch(() => undefined); // a failed switch surfaces through the connection state and the 40102 handler
        }, 0);
    };

    /** The connection was closed (or is closing) by the app: nothing Echo scheduled earlier may open it again. */
    isClosedOrClosing = (client: AblyRealtime | undefined) =>
        ["closing", "closed"].includes(client?.connection?.state ?? "");

    requestToken = async (
        channelName: string | null,
        existingToken: string | null,
    ): Promise<AblyTokenResponse> => {
        let postData = JSON.stringify({
            channel_name: channelName,
            token: existingToken,
        });
        let postOptions = {
            uri: this.authEndpoint,
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...this.authHeaders,
            },
            body: postData,
        };
        // the token itself is validated by SequentialAuthTokenRequestExecuter (R12), for both sources
        try {
            return (await httpRequestAsync(
                postOptions,
                this.httpRequestTimeout(),
            )) as AblyTokenResponse; // the parsed body: SequentialAuthTokenRequestExecuter validates it
        } catch (err) {
            // F-190: a 403 on the connection token (no channel) is not expected, since a guest gets one too; a 403 on a
            // channel is normal for guests and logs nothing
            if (
                !channelName &&
                (err as { statusCode?: unknown } | null)?.statusCode === 403
            ) {
                warnOnce(CONNECTION_TOKEN_REFUSED_HINT);
            }
            throw err;
        }
    };

    constructor(ablyConnector: AblyConnector, options: AblyOptions) {
        this.ablyConnector = ablyConnector;
        const {
            authEndpoint,
            auth: { headers },
            token,
            requestTokenFn,
        } = options;
        this.authEndpoint = fullUrl(authEndpoint);
        this.authHeaders = headers;
        this.authRequestExecuter = new SequentialAuthTokenRequestExecuter(
            token,
            requestTokenFn ?? this.requestToken,
            {
                source: requestTokenFn
                    ? "requestTokenFn"
                    : `Auth endpoint ${this.authEndpoint}`,
                // T6 queue bound. authEndpoint: never shorter than the fetch timeout (R21), so the fetch's own 50003 always
                // wins and a large httpRequestTimeout is not silently capped by the queue. A user requestTokenFn does not
                // use httpRequestTimeout, so it gets the fixed token request timeout.
                timeoutMs: requestTokenFn
                    ? TOKEN_REQUEST_TIMEOUT_MS
                    : Math.max(
                          TOKEN_REQUEST_TIMEOUT_MS,
                          this.httpRequestTimeout() + 1000,
                      ),
            },
        );
    }

    httpRequestTimeout = (): number =>
        this.ablyConnector.options?.httpRequestTimeout ??
        HTTP_REQUEST_TIMEOUT_MS;

    ablyClient = () => this.ablyConnector.ably as InternalAblyClient;

    existingToken = () => this.ablyClient().auth.tokenDetails;

    getChannel = (name: string): AblyChannel | undefined =>
        this.ablyConnector.channels[name];

    enableAuthorizeBeforeChannelAttach = () => {
        const ablyClient = this.ablyClient();
        ablyClient.getTimestamp(this.options.queryTime).catch(() => void 0); // generates serverTimeOffset in the background

        beforeChannelAttach(ablyClient, (realtimeChannel, errorCallback) => {
            const channelName = realtimeChannel.name;
            if (channelName.startsWith("public:")) {
                errorCallback(null);
                return;
            }

            // Use cached token if has channel capability and is not expired
            const tokenDetails = this.existingToken();
            if (tokenDetails && !this.isExpired(channelName)) {
                const capability = parseJwt(tokenDetails.token).payload[
                    "x-ably-capability"
                ];
                // review §8.3: the channel must be a key of the capability, not a substring of its JSON
                let tokenHasChannelCapability = false;
                try {
                    tokenHasChannelCapability =
                        Object.prototype.hasOwnProperty.call(
                            JSON.parse(capability),
                            channelName,
                        );
                } catch {
                    tokenHasChannelCapability = false; // invalid capability JSON: request a new token
                }

                // checks with server time using offset, otherwise local time
                if (
                    tokenHasChannelCapability &&
                    tokenDetails.expires > ablyClient.getTimestampUsingOffset()
                ) {
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
                    // authorize() while ably-js is still connecting aborts and restarts that connection attempt (RTC8b):
                    // an extra socket, and a leaked slow-connection timer. Wait for `connected` first.
                    this.whenConnectedOrSettled(
                        ablyClient,
                        errorCallback,
                        () => {
                            if (this.ablyClient() !== ablyClient) {
                                // Echo.connect() replaced the client while waiting; authorize() would act on the new one
                                errorCallback(
                                    Object.assign(
                                        new Error(
                                            "@ably/laravel-echo: the client was replaced while waiting for connected",
                                        ),
                                        {
                                            code: 80000,
                                        },
                                    ),
                                );
                                return;
                            }
                            this.tryAuthorizeOnSameConnection(
                                this.authOptionsForToken(jwtToken),
                                (err, _tokenDetails) => {
                                    if (err) {
                                        errorCallback(err);
                                    } else {
                                        this.removeExpired(channelName);
                                        errorCallback(null);
                                    }
                                },
                            );
                        },
                    );
                })
                .catch((err: ErrorInfo | Error) => errorCallback(err));
        });
    };

    /**
     * Runs `proceed` once the connection is `connected`: now if it already is, otherwise after waiting for it from
     * `initialized`, `connecting` or `disconnected` (authorize() in `disconnected` would trigger an early reconnect in
     * ably-js, and while connecting it restarts the attempt, RTC8b). The attach is abandoned with an error, and
     * authorize() is never called, when the connection is `failed`, `suspended`, `closing` or `closed`, at entry or
     * while waiting (the error is the connection's reason, or code 80000). The channel stays `initialized`: the error is
     * reported to the attach caller (the channel's error callbacks) and the app attaches again. The connector's re-attach
     * latch only arms on `failed`; neither ably-js nor Echo re-attaches an attach abandoned on `suspended`, `closing` or
     * `closed`. A single connection listener is used and always removed; an exception thrown by `proceed` while waiting
     * is reported through `onAbandon` too (ably-js would only log it).
     */
    whenConnectedOrSettled = (
        client: AblyRealtime | undefined,
        onAbandon: (error: ErrorInfo | Error) => void,
        proceed: () => void,
    ) => {
        const connection = client?.connection;
        const abandon = (state: string, reason?: ErrorInfo) =>
            onAbandon(
                reason ??
                    Object.assign(
                        new Error(
                            `@ably/laravel-echo: the connection is ${state}, the channel was not authorized`,
                        ),
                        {
                            code: 80000,
                        },
                    ),
            );
        const waitStates: string[] = [
            "initialized",
            "connecting",
            "disconnected",
        ];
        const abandonStates: string[] = [
            "failed",
            "suspended",
            "closing",
            "closed",
        ];
        const state = connection?.state;
        if (
            !connection ||
            !state ||
            (!waitStates.includes(state) && !abandonStates.includes(state))
        ) {
            proceed();
            return;
        }
        if (abandonStates.includes(state)) {
            abandon(state, connection.errorReason);
            return;
        }
        const listener = (stateChange?: ConnectionStateChange) => {
            const current = stateChange?.current;
            if (current === "connected") {
                connection.off(listener);
                try {
                    proceed();
                } catch (e) {
                    // ably-js's EventEmitter only logs a listener's exception: report it to the attach, as the
                    // immediate path does (its .catch(errorCallback))
                    onAbandon(e as Error);
                }
            } else if (current && abandonStates.includes(current)) {
                connection.off(listener);
                abandon(current, stateChange?.reason);
            } // initialized, connecting, disconnected: keep waiting
        };
        connection.on(listener);
    };

    clientIdSwitchListeners: {
        failed: (stateChange?: ConnectionStateChange) => void;
        connected: () => void;
        closed: () => void;
    } | null = null;

    /**
     * True while the connection is `failed` only because of a 40102 that the handler below reconnects from (Echo's
     * own clientId switch). AblyConnector.connectionStatus() then reports `reconnecting`/`connecting`, not `failed`
     * (P-01). Recorded on every `failed`, and cleared on `connected`, `closing`, `closed` and on release.
     */
    reconnectingForClientIdChange = false;

    /**
     * 40102 = the server refused a clientId change on the live connection (or ably-js refused a token for another
     * identity). Reconnect once per failure episode: the handler is re-armed only by the next `connected`, so a
     * reconnect that fails again with 40102 before connecting (failed -> connecting -> failed) cannot loop.
     */
    allowReconnectOnUserLogin = () => {
        const connection = this.ablyClient().connection;
        let armed = true;
        const failed = (stateChange?: ConnectionStateChange) => {
            // first, before onClientIdChanged(): its client.connect() emits a nested `connecting` (F-172)
            const armedBefore = armed;
            this.reconnectingForClientIdChange =
                stateChange?.reason?.code === 40102 && armedBefore;
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
            this.reconnectingForClientIdChange = false;
            endIdentitySwitch(this.ablyClient()); // E3: the switch is complete
        };
        // F-173: a close ends a suppressed switch too
        const closed = () => {
            this.reconnectingForClientIdChange = false;
        };
        connection.on("failed", failed);
        connection.on("connected", connected);
        connection.on(["closing", "closed"], closed);
        this.clientIdSwitchListeners = { failed, connected, closed };
    };

    releaseClientIdSwitchListeners = () => {
        this.reconnectingForClientIdChange = false;
        if (!this.clientIdSwitchListeners) return;
        const client = this.ablyClient();
        client?.connection?.off("failed", this.clientIdSwitchListeners.failed);
        client?.connection?.off(
            "connected",
            this.clientIdSwitchListeners.connected,
        );
        client?.connection?.off(this.clientIdSwitchListeners.closed); // both closing and closed
        if (client) {
            endIdentitySwitch(client);
            endRenewalReattach(client);
        }
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
        const client = this.ablyClient();
        client.connect();
        setTimeout(() => {
            // Echo.connect() replaced the client, or this connection failed again or was closed meanwhile: setting the
            // latch now would make the next `connected` skip the connector's re-attach
            if (
                this.ablyClient() !== client ||
                ["failed", "closing", "closed"].includes(
                    client.connection?.state ?? "",
                )
            ) {
                return;
            }
            // these attaches cover this reconnect: the connector's re-attach on the next `connected` must not attach
            // (and re-authorize, reporting a second 403) the same channels again. Set here, after the `failed` event
            // that triggered this has reached every listener, so a later failure clears it (AblyConnector).
            this.ablyConnector.channelsReattachedByAuth = true;
            for (const ablyChannel of Object.values(
                this.ablyConnector.channels,
            )) {
                ablyChannel.channel
                    .attach()
                    .catch(ablyChannel._alertErrorListeners);
            }
        }, 0);
    };

    /**
     * AuthOptions for an in-band authorize() with a new Echo JWT. ably-js keeps the first non-null clientId on the
     * Auth object for the client's lifetime (RSA15c), so a token for a different identity would fail the client with
     * 40102 (403) on every reconnect. `clientId: null` (public AuthOptions) clears it: the server still rejects the
     * in-band AUTH with 40102 (401), and allowReconnectOnUserLogin's fresh connection adopts the new clientId.
     */
    authOptionsForToken = (jwtToken: string): AuthOptions => {
        const token = toTokenDetails(jwtToken);
        const current = this.ablyClient().auth.clientId; // undefined/null while anonymous
        const identityChanges =
            current != null && current !== (token.clientId ?? null);
        return identityChanges
            ? { ...this.options, token, clientId: null }
            : { ...this.options, token };
    };

    tryAuthorizeOnSameConnection = (
        authOptions?: AuthOptions,
        callback?: AuthorizeCallback,
    ) => {
        const client = this.ablyClient();
        if (this.isClosedOrClosing(client)) {
            // a token request that finished after Echo.disconnect(): authorize() on a closed connection reconnects it
            callback?.(
                new Error("@ably/laravel-echo: the connection is closed"),
                null,
            );
            return;
        }
        const token = authOptions?.token;
        // E3: a token for another identity (including null -> user) opens the switch window before authorize(), since
        // a channel's 40102 can arrive before the connection's `failed`
        if (
            token &&
            typeof token === "object" &&
            (token.clientId ?? null) !== (client.auth.clientId ?? null)
        ) {
            beginIdentitySwitch(client);
        }
        client.auth
            .authorize(null, authOptions)
            .then(
                (tokenDetails: TokenDetails) => callback?.(null, tokenDetails),
                (err: ErrorInfo | Error) => callback?.(err, null),
            )
            .catch((e: unknown) =>
                console.error(
                    "@ably/laravel-echo: unexpected error after authorize",
                    e,
                ),
            );
    };

    onChannelFailed =
        (echoAblyChannel: AblyChannel) => (stateChange: ChannelStateChange) => {
            // channel capability rejected https://help.ably.io/error/40160
            if (stateChange.reason?.code == 40160) {
                this.handleChannelAuthError(echoAblyChannel);
            }
        };

    handleChannelAuthError = (echoAblyChannel: ReauthorizingChannel) => {
        if (echoAblyChannel.skipAuth) {
            return;
        }
        const channelName = echoAblyChannel.name;
        // get upgraded token with channel access
        this.authRequestExecuter
            .request(channelName)
            .then(({ token: jwtToken, info }) => {
                this.setPresenceInfo(echoAblyChannel, info);
                this.tryAuthorizeOnSameConnection(
                    this.authOptionsForToken(jwtToken),
                    (err, _tokenDetails) => {
                        if (err) {
                            echoAblyChannel._alertErrorListeners(err);
                        } else {
                            echoAblyChannel.skipAuth = true;
                            echoAblyChannel.channel.once("attached", () => {
                                echoAblyChannel.skipAuth = false;
                            });
                            echoAblyChannel.channel
                                .attach()
                                .catch(echoAblyChannel._alertErrorListeners);
                        }
                    },
                );
            })
            .catch((err: unknown) => echoAblyChannel._alertErrorListeners(err));
    };

    setPresenceInfo = (
        echoAblyChannel: AblyChannel | undefined,
        info: unknown,
    ) => {
        if (echoAblyChannel instanceof AblyPresenceChannel) {
            echoAblyChannel.presenceData = info;
        }
    };
}
