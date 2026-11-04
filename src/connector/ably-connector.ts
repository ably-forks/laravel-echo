import { Connector } from './connector';

import { AblyChannel, AblyPrivateChannel, AblyPresenceChannel, AblyAuth } from './../channel';
import type { AblyRealtime } from '../../typings/ably';
import { toBase64UrlEncoded, resolveAblyLib } from '../channel/ably/utils';

/**
 * This class creates a connector to Ably.
 */
export class AblyConnector extends Connector {

    /**
     * The laravel-echo library version.
     */
    static LIB_VERSION = '1.0.6';
    
    /**
     * The Ably instance.
     */
    ably: AblyRealtime;

    /**
     * All of the subscribed channel names.
     */
    channels: Record<string, AblyChannel> = {};

    /**
     * Auth instance containing all explicit channel authz ops.
     */
    ablyAuth: AblyAuth;

    /**
     * Create a fresh Ably connection.
     */
    connect(): void {
        if (typeof this.options.client !== 'undefined') {
            this.ably = this.options.client;
        } else {
            this.ablyAuth = new AblyAuth(this, this.options);
            if (!this.options.agents) {
                this.options.agents = {};
            }
            this.options.agents['laravel-echo'] = AblyConnector.LIB_VERSION;
            this.mapLegacyHostOptions();
            const AblyLib = resolveAblyLib();
            if (!AblyLib) {
                throw new Error(
                    "@ably/laravel-echo requires @ably/pubsub-device v3: `import * as Ably from '@ably/pubsub-device'; window.Ably = Ably;` " +
                        '(or load the CDN bundle, which exposes `AblyPubSub`).' +
                        (typeof Ably !== 'undefined' && Ably?.Realtime
                            ? ' Found the legacy `ably` package, which is no longer supported.'
                            : '')
                );
            }
            this.ably = AblyLib.createClient({ ...this.ablyAuth.options, ...this.options });
            this.ablyAuth.enableAuthorizeBeforeChannelAttach();
            this.ablyAuth.allowReconnectOnUserLogin();
        }
        this.reattachChannelsAfterConnectionFailure();
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
        let connectionFailed = false;
        this.ably.connection.on('failed', () => {
            connectionFailed = true;
        });
        this.ably.connection.on('connected', () => {
            if (!connectionFailed) {
                return;
            }
            connectionFailed = false;
            for (const echoChannel of Object.values(this.channels)) {
                const state = echoChannel.channel.state;
                if (state !== 'attached' && state !== 'attaching') {
                    echoChannel.channel.attach().catch(echoChannel._alertErrorListeners);
                }
            }
        });
    }

    /**
     * Listen for an event on a channel instance.
     */
    listen(name: string, event: string, callback: Function): AblyChannel {
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
            this.ablyAuth.setExpired(name);
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
     * Disconnect Ably connection.
     */
    disconnect(): void {
        this.ably.close();
    }
}
