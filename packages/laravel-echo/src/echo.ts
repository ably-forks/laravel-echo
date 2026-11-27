import type { InternalAxiosRequestConfig } from "axios";
import {
    AblyChannel,
    AblyPresenceChannel,
    AblyPrivateChannel,
    Channel,
    MercureChannel,
    MercureEncryptedPrivateChannel,
    MercurePresenceChannel,
    MercurePrivateChannel,
    NullChannel,
    NullEncryptedPrivateChannel,
    NullPresenceChannel,
    NullPrivateChannel,
    PusherChannel,
    PusherEncryptedPrivateChannel,
    PusherPresenceChannel,
    PusherPrivateChannel,
    SocketIoChannel,
    SocketIoPresenceChannel,
    SocketIoPrivateChannel,
    type PresenceChannel,
} from "./channel";
import {
    AblyConnector,
    Connector,
    MercureConnector,
    NullConnector,
    PusherConnector,
    SocketIoConnector,
    type AblyOptions,
    type MercureOptions,
    type PusherOptions,
} from "./connector";
import { isConstructor } from "./util";

/**
 * Connection status types for WebSocket connections
 */
export type ConnectionStatus =
    | "connected"
    | "disconnected"
    | "connecting"
    | "reconnecting"
    | "failed";

/**
 * A channel's visibility, as the framework adapters' hooks know it (fork-only, P-04).
 */
export type ChannelVisibility = "public" | "private" | "presence";

/**
 * This class is the primary API for interacting with broadcasting.
 */
export default class Echo<T extends keyof Broadcaster = "ably"> {
    /**
     * The broadcasting connector.
     */
    connector: Broadcaster[Exclude<T, "function">]["connector"];

    /**
     * The Echo options. `broadcaster` is always set here (the caller's, or the `"ably"` default), so readers keep
     * upstream's non-optional type even though EchoOptions accepts options without it (fork, P-02, P07-01).
     * `& { broadcaster: {} }` is NonNullable applied per driver, which keeps `broadcaster` a discriminant.
     */
    options: EchoOptions<T> & { broadcaster: {} };

    /**
     * The Echo.onConnectionChange() callbacks (fork-only; provisional: P-03, option a).
     */
    private connectionListeners?: Set<(status: ConnectionStatus) => void>;

    /**
     * Unsubscribes Echo's own listener from the current connector.
     */
    private connectorUnsubscribe?: () => void;

    /**
     * Create a new class instance.
     *
     * `broadcaster` accepts custom connector constructors alongside T; intersecting
     * them with the "function" key itself would produce an impossible type.
     *
     * Fork (P-02, provisional: P-02): `broadcaster` is optional and defaults to `"ably"`, the native Ably connector.
     * Only that case copies the options, so the caller's object is never mutated; with an explicit broadcaster
     * `this.options` is the caller's object, as upstream. `??`: an explicit `""` still throws in connect().
     */
    constructor(options: EchoOptions<T> & { broadcaster?: T | Constructor }) {
        const broadcaster = options.broadcaster ?? "ably";
        this.options = (
            broadcaster === options.broadcaster
                ? options
                : { ...options, broadcaster }
        ) as this["options"];
        this.connect();

        if (!this.options.withoutInterceptors) {
            this.registerInterceptors();
        }
    }

    /**
     * Get a channel instance by name.
     */
    channel(channel: string): Broadcaster[T]["public"] {
        return this.connector.channel(channel);
    }

    /**
     * Create a new connection.
     */
    connect(): void {
        // fork (P-03): the registry's listener leaves the connector being replaced
        this.connectorUnsubscribe?.();
        this.connectorUnsubscribe = undefined;

        if (this.connector instanceof AblyConnector) {
            this.connector.releaseClient(); // Echo.connect() called again replaces the connector
        }

        if (this.options.broadcaster === "ably") {
            this.connector = new AblyConnector(this.options);
        } else if (this.options.broadcaster === "reverb") {
            this.connector = new PusherConnector<"reverb">({
                ...this.options,
                cluster: "",
            });
        } else if (this.options.broadcaster === "pusher") {
            this.connector = new PusherConnector<"pusher">(this.options);
        } else if (this.options.broadcaster === "socket.io") {
            this.connector = new SocketIoConnector(this.options);
        } else if (this.options.broadcaster === "mercure") {
            this.connector = new MercureConnector(this.options);
        } else if (this.options.broadcaster === "null") {
            this.connector = new NullConnector(this.options);
        } else if (
            typeof this.options.broadcaster === "function" &&
            isConstructor(this.options.broadcaster)
        ) {
            this.connector = new this.options.broadcaster(this.options);
        } else {
            throw new Error(
                `Broadcaster ${typeof this.options.broadcaster} ${String(this.options.broadcaster)} is not supported.`,
            );
        }

        // fork (P-03): re-bind the registry to the new connector and report its status once
        if (this.connectionListeners?.size) {
            this.bindConnectorListener();
            this.emitConnectionStatus(this.connector.connectionStatus());
        }
    }

    /**
     * Disconnect from the Echo server.
     */
    disconnect(): void {
        this.connector.disconnect();
    }

    /**
     * Get a presence channel instance by name.
     */
    join(channel: string): Broadcaster[T]["presence"] {
        return this.connector.presenceChannel(channel);
    }

    /**
     * Leave the given channel, as well as its private and presence variants.
     */
    leave(channel: string): void {
        this.connector.leave(channel);
    }

    /**
     * Leave the given channel.
     *
     * Without `visibility`, `channel` is the connector's full channel name, as before. With it, `channel` is the
     * name the app used (`"orders"` for `echo.private("orders")`) and Echo builds the full name the connector
     * expects, so connector-neutral callers such as the framework hooks need not know the connector's prefixes
     * (fork-only; provisional: P-04, option a).
     */
    leaveChannel(channel: string, visibility?: ChannelVisibility): void {
        this.connector.leaveChannel(
            visibility
                ? this.connectorChannelName(channel, visibility)
                : channel,
        );
    }

    /**
     * The connector-specific full channel name, as used by connector.leaveChannel() (fork-only; provisional: P-04).
     */
    connectorChannelName(name: string, visibility: ChannelVisibility): string {
        if (this.connector instanceof AblyConnector) {
            return `${visibility}:${name}`;
        }

        // Pusher, Reverb, Socket.IO, Mercure, Null and custom connectors use upstream's Pusher-style names
        return visibility === "public" ? name : `${visibility}-${name}`;
    }

    /**
     * Leave all channels.
     */
    leaveAllChannels(): void {
        for (const channel in this.connector.channels) {
            this.leaveChannel(channel);
        }
    }

    /**
     * Listen for an event on a channel instance.
     */
    listen(
        channel: string,
        event: string,
        callback: CallableFunction,
    ): Broadcaster[T]["public"] {
        return this.connector.listen(channel, event, callback);
    }

    /**
     * Get a private channel instance by name.
     */
    private(channel: string): Broadcaster[T]["private"] {
        return this.connector.privateChannel(channel);
    }

    /**
     * Get a private encrypted channel instance by name.
     */
    encryptedPrivate(channel: string): Broadcaster[T]["encrypted"] {
        // fork (P-10, provisional: P-10): Ably stays out of the allow-list below, but keeps its own message
        // ("Encrypted private channels are not supported with the Ably broadcaster") instead of the generic one
        if (this.connector instanceof AblyConnector) {
            return this.connector.encryptedPrivateChannel();
        }

        if (this.connectorSupportsEncryptedPrivateChannels(this.connector)) {
            return this.connector.encryptedPrivateChannel(channel);
        }

        throw new Error(
            `Broadcaster ${typeof this.options.broadcaster} ${String(
                this.options.broadcaster,
            )} does not support encrypted private channels.`,
        );
    }

    private connectorSupportsEncryptedPrivateChannels(
        connector: unknown,
    ): connector is PusherConnector<any> | MercureConnector | NullConnector {
        return (
            connector instanceof PusherConnector ||
            connector instanceof MercureConnector ||
            connector instanceof NullConnector
        );
    }

    /**
     * Get the Socket ID for the connection.
     * For ably, returns base64 url encoded json with keys {connectionKey, clientId}
     */
    socketId(): string | undefined {
        return this.connector.socketId();
    }

    /**
     * Get the current connection status.
     */
    connectionStatus(): ConnectionStatus {
        return this.connector.connectionStatus();
    }

    /**
     * Subscribe to connection status changes; returns the unsubscribe function. Unlike
     * `echo.connector.onConnectionChange()`, the subscription survives Echo.connect() replacing the connector: the
     * callbacks move to the new connector and get its status once. Works with every connector (fork-only;
     * provisional: P-03, option a).
     */
    onConnectionChange(
        callback: (status: ConnectionStatus) => void,
    ): () => void {
        (this.connectionListeners ??= new Set()).add(callback);
        this.bindConnectorListener();
        return () => {
            this.connectionListeners?.delete(callback);
            if (!this.connectionListeners?.size) {
                this.connectorUnsubscribe?.();
                this.connectorUnsubscribe = undefined;
            }
        };
    }

    /**
     * Subscribe the registry to the current connector, once, while it has callbacks.
     */
    private bindConnectorListener(): void {
        if (this.connectorUnsubscribe || !this.connectionListeners?.size) {
            return;
        }
        this.connectorUnsubscribe = this.connector.onConnectionChange(
            (status: ConnectionStatus) => this.emitConnectionStatus(status),
        );
    }

    /**
     * Call every registry callback; a throwing callback is logged and does not stop the others.
     */
    private emitConnectionStatus(status: ConnectionStatus): void {
        this.connectionListeners?.forEach((callback) => {
            try {
                callback(status);
            } catch (e) {
                // oxlint-disable-next-line no-console -- report the callback's error without breaking the others
                console.error(e);
            }
        });
    }

    /**
     * Register 3rd party request interceptors. These are used to automatically
     * send a connections socket id to a Laravel app with a X-Socket-Id header.
     */
    registerInterceptors(): void {
        // TODO: This package is deprecated and we should remove it in a future version.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (typeof Vue !== "undefined" && Vue?.http) {
            this.registerVueRequestInterceptor();
        }

        if (typeof axios === "function") {
            this.registerAxiosRequestInterceptor();
        }

        if (typeof jQuery === "function") {
            this.registerjQueryAjaxSetup();
        }

        if (typeof Turbo === "object") {
            this.registerTurboRequestInterceptor();
        }
    }

    /**
     * Register a Vue HTTP interceptor to add the X-Socket-ID header.
     */
    registerVueRequestInterceptor(): void {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        Vue.http.interceptors.push(
            (request: Record<any, any>, next: CallableFunction) => {
                if (this.socketId()) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                    request.headers.set("X-Socket-ID", this.socketId());
                }

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                next();
            },
        );
    }

    /**
     * Register an Axios HTTP interceptor to add the X-Socket-ID header.
     */
    registerAxiosRequestInterceptor(): void {
        axios!.interceptors.request.use(
            (config: InternalAxiosRequestConfig<any>) => {
                if (this.socketId()) {
                    config.headers["X-Socket-Id"] = this.socketId();
                }

                return config;
            },
        );
    }

    /**
     * Register jQuery AjaxPrefilter to add the X-Socket-ID header.
     */
    registerjQueryAjaxSetup(): void {
        if (typeof jQuery.ajax != "undefined") {
            jQuery.ajaxPrefilter(
                (
                    _options: any,
                    _originalOptions: any,
                    xhr: Record<any, any>,
                ) => {
                    if (this.socketId()) {
                        xhr.setRequestHeader("X-Socket-Id", this.socketId());
                    }
                },
            );
        }
    }

    /**
     * Register the Turbo Request interceptor to add the X-Socket-ID header.
     */
    registerTurboRequestInterceptor(): void {
        document.addEventListener(
            "turbo:before-fetch-request",
            (event: Record<any, any>) => {
                // fork (F-252): like the other interceptors, no `X-Socket-Id: undefined` before the connection is up
                if (this.socketId()) {
                    event.detail.fetchOptions.headers["X-Socket-Id"] =
                        this.socketId();
                }
            },
        );
    }
}

/**
 * Export channel classes for TypeScript.
 */
export { Channel, Connector, type PresenceChannel };

export { EventFormatter } from "./util";

export type { AblyOptions } from "./connector";

type CustomOmit<T, K extends PropertyKey> = {
    [P in keyof T as Exclude<P, K>]: T[P];
};

/**
 * Specifies the broadcaster
 */
export type Broadcaster = {
    reverb: {
        connector: PusherConnector<"reverb">;
        public: PusherChannel<"reverb">;
        private: PusherPrivateChannel<"reverb">;
        encrypted: PusherEncryptedPrivateChannel<"reverb">;
        presence: PusherPresenceChannel<"reverb">;
        options: GenericOptions<"reverb"> &
            Partial<CustomOmit<PusherOptions<"reverb">, "cluster">>;
    };
    pusher: {
        connector: PusherConnector<"pusher">;
        public: PusherChannel<"pusher">;
        private: PusherPrivateChannel<"pusher">;
        encrypted: PusherEncryptedPrivateChannel<"pusher">;
        presence: PusherPresenceChannel<"pusher">;
        options: GenericOptions<"pusher"> & Partial<PusherOptions<"pusher">>;
    };
    ably: {
        connector: AblyConnector;
        public: AblyChannel;
        private: AblyPrivateChannel;
        encrypted: never;
        presence: AblyPresenceChannel;
        options: GenericOptions<"ably"> & Partial<AblyOptions>;
    };
    "socket.io": {
        connector: SocketIoConnector;
        public: SocketIoChannel;
        private: SocketIoPrivateChannel;
        encrypted: never;
        presence: SocketIoPresenceChannel;
        options: GenericOptions<"socket.io">;
    };
    mercure: {
        connector: MercureConnector;
        public: MercureChannel;
        private: MercurePrivateChannel;
        encrypted: MercureEncryptedPrivateChannel;
        presence: MercurePresenceChannel;
        options: GenericOptions<"mercure"> & Partial<MercureOptions>;
    };
    null: {
        connector: NullConnector;
        public: NullChannel;
        private: NullPrivateChannel;
        encrypted: NullEncryptedPrivateChannel;
        presence: NullPresenceChannel;
        options: GenericOptions<"null">;
    };
    function: {
        connector: any;
        public: any;
        private: any;
        encrypted: any;
        presence: any;
        options: GenericOptions<"function">;
    };
};

type Constructor<T = {}> = new (...args: any[]) => T;

export type BroadcastDriver = Exclude<keyof Broadcaster, "function">;

type GenericOptions<TBroadcaster extends keyof Broadcaster> = {
    /**
     * The broadcast connector. Optional in this fork: it defaults to `"ably"` (P-02).
     */
    broadcaster?: TBroadcaster extends "function"
        ? Constructor<InstanceType<Broadcaster[TBroadcaster]["connector"]>>
        : TBroadcaster;

    auth?: {
        headers: Record<string, string>;
    };
    authEndpoint?: string;
    userAuthentication?: {
        endpoint: string;
        headers: Record<string, string>;
    };
    csrfToken?: string | null;
    bearerToken?: string | null;
    host?: string | null;
    key?: string | null;
    namespace?: string | false;
    withoutInterceptors?: boolean;

    [key: string]: any;
};

export type EchoOptions<TBroadcaster extends keyof Broadcaster> =
    Broadcaster[TBroadcaster]["options"];
