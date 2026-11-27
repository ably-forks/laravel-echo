import type { AblyRealtime, AblyRealtimeChannel, ErrorInfo, InboundMessage } from '../types/ably';
import { EventFormatter } from '../util';
import { Channel } from './channel';
import type { PatchedRealtimeChannel } from './ably/attach';
import { safeInvoke, isSameError, consumeSwitchError, settleRenewalReattach } from './ably/utils';

/** The listener Echo registers with Ably for a user callback (listen() / listenToAll()). */
export type AblyMessageListener = (message: InboundMessage) => void;

/**
 * This class represents an Ably channel.
 */
export class AblyChannel extends Channel {
    /**
     * The Ably client instance.
     */
    ably: AblyRealtime;

    /**
     * The name of the channel.
     */
    name: string;

    /**
     * The event formatter.
     */
    eventFormatter: EventFormatter;

    /**
     * The subscription of the channel.
     */
    channel: AblyRealtimeChannel;

    /**
     * An array containing all registered subscribed listeners.
     */
    subscribedListeners: CallableFunction[];

    /**
     * An array containing all registered error listeners.
     */
    errorListeners: CallableFunction[];

    /**
     * Channel event subscribe callbacks, maps callback to modified implementation.
     */
    callbacks: Map<CallableFunction, AblyMessageListener>;

    /**
     * The reason of the last channel state change reported to error() listeners (cleared on attach), how many such
     * reasons were reported so far, and the last error reported to them. _alertSubscribeError uses them so one
     * failure is reported once.
     */
    lastStateChangeReason: ErrorInfo | null = null;
    stateChangeReasonCount = 0;
    lastAlertedError: unknown = null;

    /**
     * listen() wrappers, per formatted event name, then per user callback (a callback may be registered more than once).
     */
    eventCallbacks: Map<string, Map<CallableFunction, AblyMessageListener[]>> = new Map();

    /**
     * listenToAll() wrappers per user callback.
     */
    allCallbacks: Map<CallableFunction, AblyMessageListener[]> = new Map();

    /**
     * Create a new class instance.
     */
    // any: the connector passes its Ably client and options; the parity tests pass fakes (SDK boundary)
    constructor(ably: any, name: string, options: any, autoSubscribe = true) {
        super();

        this.name = name;
        this.ably = ably;
        this.options = options;
        this.eventFormatter = new EventFormatter(this.options.namespace);
        this.subscribedListeners = [];
        this.errorListeners = [];
        this.channel = ably.channels.get(name);
        (this.channel as PatchedRealtimeChannel).cancelAuthorizedAttach = false; // T17: re-joined before a cancelled authorization finished
        this.callbacks = new Map();

        if (autoSubscribe) {
            this.subscribe();
        }
    }

    /**
     * Subscribe to an Ably channel.
     */
    subscribe(): void {
        this.channel.on((stateChange) => {
            const { previous, current, reason } = stateChange;
            if (previous !== 'attached' && current == 'attached') {
                settleRenewalReattach(this.ably, this.name);
                this.lastStateChangeReason = null;
                this.subscribedListeners.forEach((listener) => safeInvoke(listener));
            } else if (reason) {
                this.lastStateChangeReason = reason;
                this.stateChangeReasonCount++;
                this._alertErrorListeners(stateChange);
            }
        });
        // E4: a rejection that the state change above already reported is not reported again
        this.channel.attach().catch(this._subscribeErrorHandler());
    }

    /**
     * Unsubscribe from an Ably channel, unregister all callbacks and finally detach the channel
     */
    unsubscribe(): void {
        this.channel.unsubscribe();
        this.callbacks.clear();
        this.eventCallbacks.clear();
        this.allCallbacks.clear();
        const channel = this.channel as PatchedRealtimeChannel;
        if (channel.authorizing) {
            // T17: the patched _attach must not attach the channel once the pending authorization completes
            channel.cancelAuthorizedAttach = true;
        }
        this.unregisterError();
        this.unregisterSubscribed();
        this.channel.off();
        this.channel.detach().catch(this._alertErrorListeners);
    }

    /**
     * Listen for an event on the channel instance.
     */
    listen(event: string, callback: CallableFunction): this {
        const name = this.eventFormatter.format(event);
        const wrapper: AblyMessageListener = ({ data, ...metaData }: InboundMessage) => callback(data, metaData);
        const byCallback = this.eventCallbacks.get(name) ?? new Map<CallableFunction, AblyMessageListener[]>();
        this.eventCallbacks.set(name, byCallback);
        byCallback.set(callback, [...(byCallback.get(callback) ?? []), wrapper]);
        this.callbacks.set(callback, wrapper); // kept for backwards compatibility of the public field
        this.channel.subscribe(name, wrapper).catch(this._subscribeErrorHandler());
        return this;
    }

    /**
     * Listen for all events on the channel instance.
     */
    listenToAll(callback: CallableFunction): this {
        const wrapper: AblyMessageListener = ({ name, data, ...metaData }: InboundMessage) => {
            // T14: `namespace: false` is a supported Echo option (EventFormatter), so don't call .replace on it
            const namespace = this.options.namespace ? String(this.options.namespace).replace(/\./g, '\\') : '';

            // `name` is optional on an Ably message: an unnamed one gives '.undefined', as with `namespace: false`
            const formattedEvent =
                namespace && name?.startsWith(namespace) ? name.substring(namespace.length + 1) : '.' + name;

            callback(formattedEvent, data, metaData);
        };
        this.allCallbacks.set(callback, [...(this.allCallbacks.get(callback) ?? []), wrapper]);
        this.callbacks.set(callback, wrapper); // kept for backwards compatibility of the public field
        this.channel.subscribe(wrapper).catch(this._subscribeErrorHandler());
        return this;
    }

    /**
     * Stop listening for an event on the channel instance.
     */
    stopListening(event: string, callback?: CallableFunction): this {
        const name = this.eventFormatter.format(event);
        if (callback) {
            // T13: never call channel.unsubscribe(name, undefined): ably treats it as "remove every listener for name"
            const wrappers = this.eventCallbacks.get(name)?.get(callback) ?? [];
            wrappers.forEach((wrapper) => this.channel.unsubscribe(name, wrapper));
            this.eventCallbacks.get(name)?.delete(callback);
            this.callbacks.delete(callback);
        } else {
            this.channel.unsubscribe(name);
            this.eventCallbacks.delete(name);
        }

        return this;
    }

    /**
     * Stop listening for all events on the channel instance.
     */
    stopListeningToAll(callback?: CallableFunction): this {
        // T13: remove only listenToAll() wrappers (PusherChannel: unbind_global), never channel.unsubscribe(undefined)
        const callbacks = callback ? [callback] : [...this.allCallbacks.keys()];
        callbacks.forEach((cb) => {
            (this.allCallbacks.get(cb) ?? []).forEach((wrapper) => this.channel.unsubscribe(wrapper));
            this.allCallbacks.delete(cb);
            this.callbacks.delete(cb);
        });

        return this;
    }

    /**
     * Register a callback to be called anytime a subscription succeeds.
     */
    subscribed(callback: CallableFunction): this {
        this.subscribedListeners.push(callback);

        return this;
    }

    /**
     * Register a callback to be called anytime a subscription error occurs.
     */
    error(callback: CallableFunction): this {
        this.errorListeners.push(callback);

        return this;
    }

    /**
     * Unregisters given error callback from the listeners.
     * @param callback
     * @returns this channel
     */
    unregisterSubscribed(callback?: CallableFunction): this {
        if (callback) {
            this.subscribedListeners = this.subscribedListeners.filter((s) => s != callback);
        } else {
            this.subscribedListeners = [];
        }

        return this;
    }

    /**
     * Unregisters given error callback from the listeners.
     * @param callback
     * @returns this channel
     */
    unregisterError(callback?: CallableFunction): this {
        if (callback) {
            this.errorListeners = this.errorListeners.filter((e) => e != callback);
        } else {
            this.errorListeners = [];
        }

        return this;
    }

    _alertErrorListeners = (err: unknown) => {
        if (!err) return;
        if (consumeSwitchError(this.ably, this.name, err)) return; // expected 40102 of an Echo-initiated identity switch
        this.lastAlertedError = err;
        this.errorListeners.forEach((listener) => safeInvoke(listener, err));
    };

    /**
     * subscribe() implicitly attaches, so its rejection is often an attach failure that was already reported: by the
     * channel state change (same reason, or same code and message) or by the attach() that started the same
     * authorization (same error object). Forward everything else once: v3 90009 while attached, a subscribe on a
     * `failed` channel, and an authorization failure that changes no state (`initialized` / `detached` channel).
     * A state change counts only if it was reported during this subscribe()'s attach attempt (after
     * `stateChangeReasonsBefore`), so an older reason with the same code and message doesn't hide a new failure.
     */
    _alertSubscribeError = (err: unknown, stateChangeReasonsBefore = -1) => {
        const reportedByStateChange =
            this.stateChangeReasonCount > stateChangeReasonsBefore && isSameError(err, this.lastStateChangeReason);
        if (this.channel.state === 'attached' || !(reportedByStateChange || err === this.lastAlertedError)) {
            this._alertErrorListeners(err);
        }
    };

    /**
     * A subscribe() rejection handler bound to the attach attempt that subscribe() starts now.
     */
    _subscribeErrorHandler = () => {
        const stateChangeReasonsBefore = this.stateChangeReasonCount;
        return (err: unknown) => this._alertSubscribeError(err, stateChangeReasonsBefore);
    };
}
