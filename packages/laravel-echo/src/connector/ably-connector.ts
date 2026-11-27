import { Connector, type EchoOptionsWithDefaults } from "./connector";

import {
    AblyChannel,
    AblyPrivateChannel,
    AblyPresenceChannel,
    AblyAuth,
} from "./../channel";
import type {
    ClientOptions,
    ConnectionState,
    ConnectionStateChange,
    PubSubClient,
} from "../types/ably";
import type { ConnectionStatus, EchoOptions } from "../echo";
import {
    toBase64UrlEncoded,
    resolveAblyLib,
    warnIfAblyGlobalsIgnored,
} from "../channel/ably/utils";

/**
 * E5: console hints for the error codes Ably uses on MAU-billed accounts, logged once per code.
 */
const MAU_HINTS: Record<number, string> = {
    40161:
        "Your Ably account requires an identified client on every connection (MAU billing), but this connection has no clientId. " +
        "Use laravel-broadcaster v2, which always issues guest client ids, or make sure your auth endpoint returns a token with a clientId.",
    40168:
        "Your Ably account is MAU-billed and only accepts the current @ably/pubsub-device (v3) SDK, but an incompatible or older SDK build connected. " +
        "Make sure a single, up-to-date @ably/pubsub-device is installed and that no other Ably SDK creates this connection.",
    40167:
        "A server-side Ably client needs the server claim on its token to connect to a MAU-billed account. This is usually a server-side " +
        "configuration issue (laravel-broadcaster / token issuing), not a browser issue.",
};

/**
 * The connection events the status listener is bound to (Phase 06). Per event on purpose, never `connection.on(cb)`:
 * ably calls catch-all listeners before per-event ones, and AblyAuth's `failed` listener must record the 40102 flag
 * before the status listener reads it (F-172). `update` = a new connection key or clientId while connected (F-096).
 */
const STATUS_EVENTS: Array<ConnectionState | "update"> = [
    "initialized",
    "connecting",
    "connected",
    "disconnected",
    "suspended",
    "closing",
    "closed",
    "failed",
    "update",
];

/**
 * How long a `failed` (40102) of Echo's own clientId reconnect is reported as `reconnecting`/`connecting` when the
 * connection stays failed (P-01).
 */
const SUPPRESSED_FAILED_FALLBACK_MS = 1000;

/**
 * What a token request must resolve with, from `authEndpoint` or `requestTokenFn`: a signed Ably JWT, and for a
 * presence channel the member data (`info`). SequentialAuthTokenRequestExecuter rejects a response without a
 * non-empty string `token`.
 */
export type AblyTokenResponse = { token: string; info?: unknown };

/** Echo-only options of the native Ably connector; every other key is passed to Ably as a client option. */
export type AblyOptions = EchoOptionsWithDefaults<"ably"> &
    Partial<ClientOptions> & {
        /** Use this Ably client instead of creating one (Echo does not switch its identity). */
        client?: PubSubClient;
        /**
         * Fetch a signed token yourself instead of calling `authEndpoint`. `channelName` is `null` for the
         * connection token, and `existingToken` is `null` until Echo has a token. Each call is bounded to 30 s.
         * Method syntax on purpose: a function typed `(channelName: string, existingToken: string)`, as in the
         * README, is still accepted.
         */
        requestTokenFn?(
            channelName: string | null,
            existingToken: string | null,
        ): Promise<AblyTokenResponse>;
        /** An initial token (JWT), used before the first token request. */
        token?: string;
        /** Fetch timeout for `authEndpoint` requests, in ms (default 10000). */
        httpRequestTimeout?: number;
    };

/**
 * This class creates a connector to Ably.
 */
export class AblyConnector extends Connector<
    "ably",
    AblyChannel,
    AblyPrivateChannel,
    AblyPresenceChannel
> {
    /**
     * The laravel-echo library version.
     */
    static LIB_VERSION: string = __ECHO_VERSION__;

    /**
     * Echo-only option keys, never passed to createClient (review P4): bearer and CSRF tokens, the auth endpoint and
     * other Echo settings would otherwise be copied into the Ably client options and its debug logs. `token` is not
     * Echo-only: it is also an Ably client option (v3 seeds its cached token from it), and Echo's token executer reads
     * it too.
     */
    static ECHO_ONLY_KEYS = [
        "broadcaster",
        "authEndpoint",
        "auth",
        "userAuthentication",
        "namespace",
        "csrfToken",
        "bearerToken",
        "host",
        "requestTokenFn",
        "client",
        "withoutInterceptors",
    ];

    /**
     * Connector options. Set by Connector.setOptions() from the base constructor.
     *
     * The fields below that connect() assigns are `declare`d (E-06, F-048): connect() runs from the base constructor,
     * before this class's field initializers, so with ES2022 class fields (define semantics) a plain declaration
     * would reset them to `undefined` after super(). Never give them an initializer.
     */
    declare options: AblyOptions;

    /**
     * The Ably instance. Set by connect(), which runs from the base constructor.
     */
    declare ably: PubSubClient;

    /**
     * All of the subscribed channel names.
     */
    channels: Record<string, AblyChannel> = {};

    /**
     * Auth instance containing all explicit channel authz ops. Set by connect(); undefined for a user-supplied
     * options.client (P3).
     */
    declare ablyAuth: AblyAuth | undefined;

    /**
     * The MAU hint codes already logged by this connector (each code once).
     */
    mauHintsLogged = new Set<number>();

    /**
     * Set by AblyAuth.onClientIdChanged when it has re-attached every channel for a client ID change; the next
     * `connected` then skips the re-attach below once. Cleared by any later `failed`, `disconnected` or `suspended`.
     */
    channelsReattachedByAuth = false;

    /**
     * The connection listeners of the re-attach latch (R3), so releaseClient() can remove them (P7). No initializer:
     * connect() sets it from the base constructor, before field initializers run (like ablyAuth).
     */
    declare recoveryListeners: {
        failed: (stateChange?: ConnectionStateChange) => void;
        connected: () => void;
        interrupted: () => void;
    } | null;

    /*
     * Connection status state (Phase 06, P-01). Every field is `declare`d and never given an initializer (E-06,
     * F-049): connect() sets them from the base constructor, or they are created lazily.
     */

    /**
     * Whether this client has reached `connected` at least once (`connecting`/`disconnected` then map to
     * `reconnecting`). Reset for a new client, kept when connect() reuses a supplied options.client.
     */
    declare private hasConnected: boolean;

    /**
     * The onConnectionChange() callbacks. Kept when connect() is called again: they are re-bound to the new client.
     */
    declare private statusListeners:
        | Set<(status: ConnectionStatus) => void>
        | undefined;

    /** The status and socket id of the last emission (dedupe). */
    declare private lastEmitted: ConnectionStatus | undefined;
    declare private lastSocketId: string | undefined;

    /** The connection listener behind onConnectionChange(); releaseClient() removes it. */
    declare private connectionStatusListener:
        | ((stateChange?: ConnectionStateChange) => void)
        | undefined;

    /** Emits `failed` if a suppressed 40102 `failed` outlasts SUPPRESSED_FAILED_FALLBACK_MS. */
    declare private failedFallbackTimer:
        | ReturnType<typeof setTimeout>
        | undefined;

    /**
     * Merge the custom options with the defaults (E-07, F-046).
     *
     * Upstream merges a static `_defaultOptions` shallowly, so `auth.headers` and `userAuthentication.headers`
     * would be one object shared by every connector (and the caller's object would be mutated). Pass fresh copies
     * so the CSRF and bearer-token writes below never leak to another connector or survive a logout. A header the
     * caller set explicitly is kept. `agents` is copied for the same reason (F-342). Fork-only: the upstream
     * Connector is not changed.
     */
    protected setOptions(options: EchoOptions<"ably">): void {
        const auth = options.auth ?? Connector._defaultOptions.auth;
        const userAuthentication =
            options.userAuthentication ??
            Connector._defaultOptions.userAuthentication;
        super.setOptions({
            ...options,
            agents: { ...options.agents }, // F-342: connect() adds laravel-echo to a copy, not to the caller's object
            auth: { ...auth, headers: { ...auth.headers } },
            userAuthentication: {
                ...userAuthentication,
                headers: { ...userAuthentication.headers },
            },
        });
    }

    /**
     * Create a fresh Ably connection.
     */
    connect(): void {
        const previous = this.ably as PubSubClient | undefined;
        if (this.ably) {
            this.releaseClient(); // P7: connect() called again
        }
        if (typeof this.options.client !== "undefined") {
            // P3: a user-supplied client gets no AblyAuth, so the pre-attach authorize (and the 40160 re-authorize of
            // private and presence channels) is not installed; its own auth must grant the channel capabilities.
            this.ably = this.options.client;
        } else {
            this.ablyAuth = new AblyAuth(this, this.options);
            if (!this.options.agents) {
                this.options.agents = {};
            }
            this.options.agents["laravel-echo"] = AblyConnector.LIB_VERSION;
            this.mapLegacyHostOptions();
            // single install: Echo's own @ably/pubsub-device, never a global (a user-supplied options.client above is
            // the only way to use another copy)
            warnIfAblyGlobalsIgnored();
            this.ably = resolveAblyLib().createClient({
                ...this.ablyAuth.options,
                ...this.clientOptions(),
            });
            this.ablyAuth.enableAuthorizeBeforeChannelAttach();
            this.ablyAuth.allowReconnectOnUserLogin();
        }
        this.reattachChannelsAfterConnectionFailure();
        // last: AblyAuth's and the re-attach latch's listeners run before the status listener (F-172)
        this.bindConnectionStatus(previous);
    }

    /**
     * P7: leave the existing Echo channels, so none stays bound to this client, and close the client (unless it is the
     * user-supplied client, which may be reused). Channels are not re-bound: callers re-subscribe after reconnecting.
     * Called when connect() is called again, and by Echo.connect() before it replaces this connector.
     */
    releaseClient(): void {
        Object.keys(this.channels).forEach((name) => this.leaveChannel(name));
        if (this.ably && this.recoveryListeners) {
            // a supplied options.client may be reused: don't leave a listener pair on it per connect()
            this.ably.connection.off("failed", this.recoveryListeners.failed);
            this.ably.connection.off(
                "connected",
                this.recoveryListeners.connected,
            );
            this.ably.connection.off(
                "disconnected",
                this.recoveryListeners.interrupted,
            );
            this.ably.connection.off(
                "suspended",
                this.recoveryListeners.interrupted,
            );
            this.recoveryListeners = null;
        }
        if (this.ably && this.connectionStatusListener) {
            this.ably.connection.off(this.connectionStatusListener);
            this.connectionStatusListener = undefined;
        }
        clearTimeout(this.failedFallbackTimer);
        this.failedFallbackTimer = undefined;
        this.ablyAuth?.releaseClientIdSwitchListeners(); // before close(), while this.ably is still the old client
        if (this.ably && this.ably !== this.options.client) {
            this.ably.close();
        }
    }

    /**
     * The options passed to createClient: Echo's options without the Echo-only keys (P4). `this.options` is not
     * modified, so Echo keeps reading its own settings from it.
     */
    clientOptions(): ClientOptions {
        const clientOptions: Record<string, unknown> = { ...this.options };
        AblyConnector.ECHO_ONLY_KEYS.forEach(
            (key) => delete clientOptions[key],
        );
        return clientOptions;
    }

    /**
     * R5: @ably/pubsub-device v3 silently ignores `environment`, `realtimeHost` and `restHost`. Map them to `endpoint`
     * (with a warning) instead of silently connecting to the production cluster. `this.options` is a per-connector
     * copy, so the user's own options object is not mutated.
     */
    mapLegacyHostOptions(): void {
        const { environment, realtimeHost, restHost } = this.options;
        if (environment == null && realtimeHost == null && restHost == null) {
            return;
        }
        if (this.options.endpoint == null) {
            if (restHost && realtimeHost && restHost !== realtimeHost) {
                console.warn(
                    "@ably/laravel-echo: restHost and realtimeHost differ; using realtimeHost as endpoint.",
                );
            }
            const host = realtimeHost ?? restHost;
            if (
                host &&
                !host.includes(".") &&
                !host.includes("::") &&
                host !== "localhost"
            ) {
                // '::' = IPv6
                console.warn(
                    `@ably/laravel-echo: '${host}' has no dot, so @ably/pubsub-device treats it as a routing-policy id, not a hostname.`,
                );
            }
            this.options.endpoint =
                host ??
                (environment === "production"
                    ? undefined
                    : environment === "sandbox"
                      ? "nonprod:sandbox"
                      : environment);
        }
        // delete so they never reach the client (ably@2 would throw 40106 alongside `endpoint`)
        delete this.options.environment;
        delete this.options.realtimeHost;
        delete this.options.restHost;
        console.warn(
            `@ably/laravel-echo: environment/realtimeHost/restHost are not supported by @ably/pubsub-device; use 'endpoint' (now '${
                this.options.endpoint ?? "default"
            }').`,
        );
    }

    /**
     * R3 (Echo-side resilience): v3 never re-attaches channels that went `failed`, and a connection never goes
     * straight from `failed` to `connected` (failed -> connecting -> connected). Remember that the connection failed
     * and, on the next `connected`, re-attach every Echo channel that is not attached/attaching (this includes
     * `initialized` channels whose authorize failed). Installed here, not in AblyAuth, so it also covers `options.client`.
     */
    reattachChannelsAfterConnectionFailure(): void {
        // a supplied options.client may already be failed: no later state change would tell us
        let connectionFailed = this.ably.connection.state === "failed";
        const failed = (stateChange?: ConnectionStateChange) => {
            connectionFailed = true;
            this.channelsReattachedByAuth = false; // that re-attach did not survive this failure

            // E5: a hint only for the MAU codes (40161, 40168, 40167), once per code
            const reason = stateChange?.reason;
            const code = reason?.code;
            const hint = code !== undefined ? MAU_HINTS[code] : undefined;
            if (
                reason &&
                code !== undefined &&
                hint &&
                !this.mauHintsLogged.has(code)
            ) {
                this.mauHintsLogged.add(code);
                console.error(
                    `@ably/laravel-echo: the Ably connection failed (${code}: ${reason.message}). ${hint}`,
                );
            }
        };
        const connected = () => {
            if (!connectionFailed) {
                return;
            }
            connectionFailed = false;
            if (this.channelsReattachedByAuth) {
                this.channelsReattachedByAuth = false;
                return;
            }
            for (const echoChannel of Object.values(this.channels)) {
                const state = echoChannel.channel.state;
                if (state !== "attached" && state !== "attaching") {
                    echoChannel.channel
                        .attach()
                        .catch(echoChannel._alertErrorListeners);
                }
            }
        };
        // a reconnect that is interrupted before `connected` (disconnected/suspended) may lose the client ID change
        // handler's attaches too: don't skip the re-attach then
        const interrupted = () => {
            this.channelsReattachedByAuth = false;
        };
        this.ably.connection.on("failed", failed);
        this.ably.connection.on("connected", connected);
        this.ably.connection.on("disconnected", interrupted);
        this.ably.connection.on("suspended", interrupted);
        this.recoveryListeners = { failed, connected, interrupted };
    }

    /**
     * Listen for an event on a channel instance.
     */
    listen(
        name: string,
        event: string,
        callback: CallableFunction,
    ): AblyChannel {
        return this.channel(name).listen(event, callback);
    }

    /**
     * Get a channel instance by name.
     */
    channel(name: string): AblyChannel {
        const prefixedName = `public:${name}`; // adding public as a ably namespace prefix
        if (!this.channels[prefixedName]) {
            this.channels[prefixedName] = new AblyChannel(
                this.ably,
                prefixedName,
                this.options,
            );
        }

        return this.channels[prefixedName];
    }

    /**
     * Get a private channel instance by name.
     */
    privateChannel(name: string): AblyPrivateChannel {
        const prefixedName = `private:${name}`; // adding private as a ably namespace prefix
        if (!this.channels[prefixedName]) {
            this.channels[prefixedName] = new AblyPrivateChannel(
                this.ably,
                prefixedName,
                this.options,
                this.ablyAuth,
            );
        }

        return this.channels[prefixedName] as AblyPrivateChannel;
    }

    /**
     * Get a presence channel instance by name.
     */
    presenceChannel(name: string): AblyPresenceChannel {
        const prefixedName = `presence:${name}`; // adding presence as a ably namespace prefix
        if (!this.channels[prefixedName]) {
            this.channels[prefixedName] = new AblyPresenceChannel(
                this.ably,
                prefixedName,
                this.options,
                this.ablyAuth,
            );
        }

        return this.channels[prefixedName] as AblyPresenceChannel;
    }

    /**
     * Encrypted private channels are a Pusher feature with no Ably equivalent (review P6).
     */
    encryptedPrivateChannel(): never {
        throw new Error(
            "Encrypted private channels are not supported with the Ably broadcaster",
        );
    }

    /**
     * Leave the given channel, as well as its private and presence variants.
     */
    leave(name: string): void {
        let channels = [
            `public:${name}`,
            `private:${name}`,
            `presence:${name}`,
        ];

        channels.forEach((name: string, index: number) => {
            this.leaveChannel(name);
        });
    }

    /**
     * Leave the given channel.
     */
    leaveChannel(name: string): void {
        if (
            name.indexOf("public:") !== 0 &&
            name.indexOf("private:") !== 0 &&
            name.indexOf("presence:") !== 0
        ) {
            throw new Error(
                `Error leaving ${name}, name should be prefixed with either "public:", "private:" or "presence:"`,
            );
        }
        if (this.channels[name]) {
            this.channels[name].unsubscribe();
            this.ablyAuth?.setExpired(name); // P3: no AblyAuth with options.client
            delete this.channels[name];
        }
    }

    /**
     * Get the socket ID for the connection.
     * For ably, returns base64 url encoded json with keys {connectionKey, clientId}, and `undefined` until the
     * connection has a key (F-064, F-204), as upstream's connectors do: no bogus X-Socket-Id before connecting.
     */
    socketId(): string | undefined {
        if (!this.ably?.connection?.key) {
            return undefined;
        }
        let socketIdObject = {
            connectionKey: this.ably.connection.key,
            clientId: this.ably.auth.clientId ?? null,
        };
        return toBase64UrlEncoded(JSON.stringify(socketIdObject));
    }

    /**
     * Get the current connection status (P-01, provisional: P-01). Ably's connection state, mapped:
     * - `initialized`: `disconnected` when autoConnect is off, otherwise `connecting`;
     * - `connecting`, `disconnected`: `reconnecting` once this client has connected, otherwise `connecting`;
     * - `connected`: `connected`;
     * - `suspended`, `closing`, `closed`: `disconnected`;
     * - `failed`: `failed`, except the transient 40102 of Echo's own clientId reconnect, reported as
     *   `reconnecting`/`connecting` (for at most 1 s if the connection stays failed).
     */
    connectionStatus(): ConnectionStatus {
        const connection = this.ably?.connection;
        switch (connection?.state) {
            case "connected":
                return "connected";
            case "initialized":
                return this.autoConnectDisabled()
                    ? "disconnected"
                    : "connecting";
            case "connecting":
            case "disconnected":
                return this.hasConnected ? "reconnecting" : "connecting";
            case "failed":
                if (this.ablyAuth?.reconnectingForClientIdChange) {
                    return this.hasConnected ? "reconnecting" : "connecting";
                }
                return "failed";
            default:
                return "disconnected"; // suspended, closing, closed
        }
    }

    /**
     * Subscribe to connection status changes; returns the unsubscribe function. The callback is not called on
     * subscribe, only on a change of the status or of socketId() (F-096). Survives connect() called again; to also
     * survive Echo.connect(), which replaces the connector, use Echo.onConnectionChange().
     */
    onConnectionChange(
        callback: (status: ConnectionStatus) => void,
    ): () => void {
        (this.statusListeners ??= new Set()).add(callback);
        return () => {
            this.statusListeners?.delete(callback);
        };
    }

    /**
     * Whether the client does not connect by itself: Echo's own `autoConnect` option for the client Echo creates
     * (F-189), the client's own options for a supplied options.client (F-176: `client.options` is not in ably's
     * types, but @ably/pubsub-device 3.2 keeps `autoConnect` there, verified on a real client).
     */
    private autoConnectDisabled(): boolean {
        if (typeof this.options.client === "undefined") {
            return this.options.autoConnect === false;
        }
        const client = this.ably as PubSubClient & { options?: ClientOptions };
        return client?.options?.autoConnect === false;
    }

    /**
     * Bind the status listener to the current client (from connect(), after every other connection listener). When
     * connect() is called again, the existing onConnectionChange() callbacks get the new client's status.
     */
    private bindConnectionStatus(previous: PubSubClient | undefined): void {
        const connection = this.ably.connection;
        this.hasConnected =
            (previous === this.ably && this.hasConnected) ||
            connection.state === "connected";
        const listener = (stateChange?: ConnectionStateChange) => {
            clearTimeout(this.failedFallbackTimer); // any later event cancels the fallback
            this.failedFallbackTimer = undefined;
            const current = stateChange?.current;
            if (current === "connected") {
                this.hasConnected = true; // also when the event is stale below
            }
            if (current !== connection.state) {
                return; // stale: a nested change (onClientIdChanged's connect()) already ran
            }
            if (
                current === "failed" &&
                this.ablyAuth?.reconnectingForClientIdChange
            ) {
                const auth = this.ablyAuth;
                this.failedFallbackTimer = setTimeout(() => {
                    this.failedFallbackTimer = undefined;
                    if (connection.state === "failed") {
                        auth.reconnectingForClientIdChange = false;
                        this.emitConnectionStatus();
                    }
                }, SUPPRESSED_FAILED_FALLBACK_MS);
            }
            this.emitConnectionStatus();
        };
        this.connectionStatusListener = listener;
        connection.on(STATUS_EVENTS, listener);
        if (previous) {
            this.emitConnectionStatus(true);
        } else {
            this.lastEmitted = this.connectionStatus();
            this.lastSocketId = this.socketId();
        }
    }

    /**
     * Call the onConnectionChange() callbacks when the status or socketId() changed (or when `force`d). A throwing
     * callback is logged and does not stop the others.
     */
    private emitConnectionStatus(force = false): void {
        const status = this.connectionStatus();
        const socketId = this.socketId();
        if (
            !force &&
            status === this.lastEmitted &&
            socketId === this.lastSocketId
        ) {
            return;
        }
        this.lastEmitted = status;
        this.lastSocketId = socketId;
        this.statusListeners?.forEach((callback) => {
            try {
                callback(status);
            } catch (e) {
                console.error(e);
            }
        });
    }

    /**
     * Disconnect Ably connection.
     */
    disconnect(): void {
        this.ably.close();
    }
}
