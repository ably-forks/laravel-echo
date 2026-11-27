import { Connector, type EchoOptionsWithDefaults } from './connector';

import { AblyChannel, AblyPrivateChannel, AblyPresenceChannel, AblyAuth } from './../channel';
import type { ClientOptions, ConnectionStateChange, PubSubClient } from '../types/ably';
import type { ConnectionStatus, EchoOptions } from '../echo';
import { toBase64UrlEncoded, resolveAblyLib, warnIfAblyGlobalsIgnored } from '../channel/ably/utils';

/**
 * E5: console hints for the error codes Ably uses on MAU-billed accounts, logged once per code.
 */
const MAU_HINTS: Record<number, string> = {
    40161: 'Your Ably account requires an identified client on every connection (MAU billing), but this guest connected without a clientId. ' +
        'In laravel-broadcaster set ABLY_MAU_ACCOUNT=true (config broadcasting.connections.ably.mau_account) so guests receive a clientId, ' +
        'or only connect Echo for signed-in users. See "Guest users on MAU-billed Ably accounts" in the README.',
    40168: 'Your Ably account is MAU-billed and only accepts the current @ably/pubsub-device (v3) SDK, but an incompatible or older SDK build connected. ' +
        'Make sure a single, up-to-date @ably/pubsub-device is installed and that no other Ably SDK creates this connection.',
    40167: 'A server-side Ably client needs the server claim on its token to connect to a MAU-billed account. This is usually a server-side ' +
        'configuration issue (laravel-broadcaster / token issuing), not a browser issue.',
};

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
        requestTokenFn?(channelName: string | null, existingToken: string | null): Promise<AblyTokenResponse>;
        /** An initial token (JWT), used before the first token request. */
        token?: string;
        /** Fetch timeout for `authEndpoint` requests, in ms (default 10000). */
        httpRequestTimeout?: number;
    };

/**
 * This class creates a connector to Ably.
 */
export class AblyConnector extends Connector<"ably", AblyChannel, AblyPrivateChannel, AblyPresenceChannel> {

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
        'broadcaster',
        'authEndpoint',
        'auth',
        'userAuthentication',
        'namespace',
        'csrfToken',
        'bearerToken',
        'host',
        'requestTokenFn',
        'client',
        'withoutInterceptors',
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

    /**
     * Merge the custom options with the defaults (E-07, F-046).
     *
     * Upstream merges a static `_defaultOptions` shallowly, so `auth.headers` and `userAuthentication.headers`
     * would be one object shared by every connector (and the caller's object would be mutated). Pass fresh copies
     * so the CSRF and bearer-token writes below never leak to another connector or survive a logout. A header the
     * caller set explicitly is kept. Fork-only: the upstream Connector is not changed.
     */
    protected setOptions(options: EchoOptions<"ably">): void {
        const auth = options.auth ?? Connector._defaultOptions.auth;
        const userAuthentication = options.userAuthentication ?? Connector._defaultOptions.userAuthentication;
        super.setOptions({
            ...options,
            auth: { ...auth, headers: { ...auth.headers } },
            userAuthentication: { ...userAuthentication, headers: { ...userAuthentication.headers } },
        });
    }

    /**
     * Create a fresh Ably connection.
     */
    connect(): void {
        if (this.ably) {
            this.releaseClient(); // P7: connect() called again
        }
        if (typeof this.options.client !== 'undefined') {
            // P3: a user-supplied client gets no AblyAuth, so the pre-attach authorize (and the 40160 re-authorize of
            // private and presence channels) is not installed; its own auth must grant the channel capabilities.
            this.ably = this.options.client;
        } else {
            this.ablyAuth = new AblyAuth(this, this.options);
            if (!this.options.agents) {
                this.options.agents = {};
            }
            this.options.agents['laravel-echo'] = AblyConnector.LIB_VERSION;
            this.mapLegacyHostOptions();
            // single install: Echo's own @ably/pubsub-device, never a global (a user-supplied options.client above is
            // the only way to use another copy)
            warnIfAblyGlobalsIgnored();
            this.ably = resolveAblyLib().createClient({ ...this.ablyAuth.options, ...this.clientOptions() });
            this.ablyAuth.enableAuthorizeBeforeChannelAttach();
            this.ablyAuth.allowReconnectOnUserLogin();
        }
        this.reattachChannelsAfterConnectionFailure();
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
            this.ably.connection.off('failed', this.recoveryListeners.failed);
            this.ably.connection.off('connected', this.recoveryListeners.connected);
            this.ably.connection.off('disconnected', this.recoveryListeners.interrupted);
            this.ably.connection.off('suspended', this.recoveryListeners.interrupted);
            this.recoveryListeners = null;
        }
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
        AblyConnector.ECHO_ONLY_KEYS.forEach((key) => delete clientOptions[key]);
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
                console.warn('@ably/laravel-echo: restHost and realtimeHost differ; using realtimeHost as endpoint.');
            }
            const host = realtimeHost ?? restHost;
            if (host && !host.includes('.') && !host.includes('::') && host !== 'localhost') {
                // '::' = IPv6
                console.warn(
                    `@ably/laravel-echo: '${host}' has no dot, so @ably/pubsub-device treats it as a routing-policy id, not a hostname.`
                );
            }
            this.options.endpoint =
                host ?? (environment === 'production' ? undefined : environment === 'sandbox' ? 'nonprod:sandbox' : environment);
        }
        // delete so they never reach the client (ably@2 would throw 40106 alongside `endpoint`)
        delete this.options.environment;
        delete this.options.realtimeHost;
        delete this.options.restHost;
        console.warn(
            `@ably/laravel-echo: environment/realtimeHost/restHost are not supported by @ably/pubsub-device; use 'endpoint' (now '${
                this.options.endpoint ?? 'default'
            }').`
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
        let connectionFailed = this.ably.connection.state === 'failed';
        const failed = (stateChange?: ConnectionStateChange) => {
            connectionFailed = true;
            this.channelsReattachedByAuth = false; // that re-attach did not survive this failure

            // E5: a hint only for the MAU codes (40161, 40168, 40167), once per code
            const reason = stateChange?.reason;
            const code = reason?.code;
            const hint = code !== undefined ? MAU_HINTS[code] : undefined;
            if (reason && code !== undefined && hint && !this.mauHintsLogged.has(code)) {
                this.mauHintsLogged.add(code);
                console.error(`@ably/laravel-echo: the Ably connection failed (${code}: ${reason.message}). ${hint}`);
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
                if (state !== 'attached' && state !== 'attaching') {
                    echoChannel.channel.attach().catch(echoChannel._alertErrorListeners);
                }
            }
        };
        // a reconnect that is interrupted before `connected` (disconnected/suspended) may lose the client ID change
        // handler's attaches too: don't skip the re-attach then
        const interrupted = () => {
            this.channelsReattachedByAuth = false;
        };
        this.ably.connection.on('failed', failed);
        this.ably.connection.on('connected', connected);
        this.ably.connection.on('disconnected', interrupted);
        this.ably.connection.on('suspended', interrupted);
        this.recoveryListeners = { failed, connected, interrupted };
    }

    /**
     * Listen for an event on a channel instance.
     */
    listen(name: string, event: string, callback: CallableFunction): AblyChannel {
        return this.channel(name).listen(event, callback);
    }

    /**
     * Get a channel instance by name.
     */
    channel(name: string): AblyChannel {
        const prefixedName = `public:${name}`; // adding public as a ably namespace prefix
        if (!this.channels[prefixedName]) {
            this.channels[prefixedName] = new AblyChannel(this.ably, prefixedName, this.options);
        }

        return this.channels[prefixedName];
    }

    /**
     * Get a private channel instance by name.
     */
    privateChannel(name: string): AblyPrivateChannel {
        const prefixedName = `private:${name}`; // adding private as a ably namespace prefix
        if (!this.channels[prefixedName]) {
            this.channels[prefixedName] = new AblyPrivateChannel(this.ably, prefixedName, this.options, this.ablyAuth);
        }

        return this.channels[prefixedName] as AblyPrivateChannel;
    }

    /**
     * Get a presence channel instance by name.
     */
    presenceChannel(name: string): AblyPresenceChannel {
        const prefixedName = `presence:${name}`; // adding presence as a ably namespace prefix
        if (!this.channels[prefixedName]) {
            this.channels[prefixedName] = new AblyPresenceChannel(this.ably, prefixedName, this.options, this.ablyAuth);
        }

        return this.channels[prefixedName] as AblyPresenceChannel;
    }

    /**
     * Encrypted private channels are a Pusher feature with no Ably equivalent (review P6).
     */
    encryptedPrivateChannel(): never {
        throw new Error('Encrypted private channels are not supported with the Ably broadcaster');
    }

    /**
     * Leave the given channel, as well as its private and presence variants.
     */
    leave(name: string): void {
        let channels = [`public:${name}`, `private:${name}`, `presence:${name}`];

        channels.forEach((name: string, index: number) => {
            this.leaveChannel(name);
        });
    }

    /**
     * Leave the given channel.
     */
    leaveChannel(name: string): void {
        if (name.indexOf('public:') !== 0 && name.indexOf('private:') !== 0 && name.indexOf('presence:') !== 0) {
            throw new Error(
                `Error leaving ${name}, name should be prefixed with either "public:", "private:" or "presence:"`
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
     * For ably, returns base64 url encoded json with keys {connectionKey, clientId}
     */
    socketId(): string {
        let socketIdObject = {
            connectionKey : this.ably.connection.key,
            clientId : this.ably.auth.clientId ?? null,
        }
        return toBase64UrlEncoded(JSON.stringify(socketIdObject));
    }

    /**
     * Get the current connection status.
     * [provisional: replaced by Phase 06 / P-01] Temporary stub, implemented in Phase 06.
     */
    connectionStatus(): ConnectionStatus {
        const s = this.ably?.connection.state;
        return s === 'connected'
            ? 'connected'
            : s === 'failed'
              ? 'failed'
              : s === 'connecting' || s === 'initialized'
                ? 'connecting'
                : 'disconnected';
    }

    /**
     * Subscribe to connection status changes; returns the unsubscribe function.
     * [provisional: replaced by Phase 06 / P-01] Temporary stub, implemented in Phase 06.
     */
    onConnectionChange(callback: (status: ConnectionStatus) => void): () => void {
        const listener = () => callback(this.connectionStatus());
        this.ably.connection.on(listener);
        return () => this.ably.connection.off(listener);
    }

    /**
     * Disconnect Ably connection.
     */
    disconnect(): void {
        this.ably.close();
    }
}
