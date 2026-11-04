import { isNullOrUndefined } from './utils';

/** Echo's authorize function per ably client: only clients Echo created go through the pre-attach authorize. */
const authorizers = new WeakMap<object, Function>();

/** RealtimeChannel prototypes whose _attach is patched; each ably build (node, browser, debug, ...) has its own. */
const patchedPrototypes = new WeakSet<object>();

const PROBE_CHANNEL = 'dummy';

/**
 * Modifies existing channel attach with custom authz implementation, for the given client only.
 *
 * Only attaches that go through RealtimeChannel._attach are authorized first: channel.attach() (and so subscribe(),
 * presence.subscribe(), presence.enter() on an initialized channel, Echo's 40160 recovery), a suspended channel
 * re-attached when the connection becomes active, and ably's decode-failure recovery. ably re-attaches some
 * channels internally without _attach, so they send ATTACH with the connection's current token and skip this step:
 * - attached channels when the connection becomes active again, resumed or not (Channels.onTransportActive);
 * - attaching channels re-sending their ATTACH after a reconnect (checkPendingState);
 * - a server DETACHED on an attached or suspended channel (RTL13a);
 * - the retry timer of a suspended channel (RTL13b);
 * - channel.setOptions() that needs a re-attach (RTL16a).
 * ably's re-entry of its own presence members after a re-attach (RTP17) is not an attach. If the token no longer
 * has the channel's capability, such a re-attach fails with 40160 and AblyAuth.onChannelFailed re-authorizes
 * private and presence channels.
 */
export const beforeChannelAttach = (ablyClient, authorize: Function) => {
    const probeExisted = !!ablyClient.channels.all?.[PROBE_CHANNEL];
    const probe = ablyClient.channels.get(PROBE_CHANNEL);
    const prototype = Object.getPrototypeOf(probe);
    authorizers.set(probe.client ?? ablyClient, authorize);
    if (!probeExisted) {
        ablyClient.channels.release?.(PROBE_CHANNEL); // the probe was only needed to reach the prototype
    }
    if (patchedPrototypes.has(prototype)) {
        return;
    }
    const internalAttach = prototype._attach;
    if (isNullOrUndefined(internalAttach)) {
        console.warn('Failed to enable authorize for pre-attach, please check for right library version');
        return;
    }
    function customInternalAttach(forceReattach, attachReason, errCallback) {
        const authorizeChannel = authorizers.get(this.client);
        if (!authorizeChannel) {
            // a client Echo doesn't own (e.g. the app's own createClient() from the same build): ably's attach, unchanged
            internalAttach.call(this, forceReattach, attachReason, errCallback);
            return;
        }
        if (this.authorizing) {
            (this._pendingAttachCbs ??= []).push(errCallback); // P1: don't drop, settle after authorize
            return;
        }
        this.authorizing = true;
        let settled = false;
        const done = (error) => {
            if (settled) return; // authorizeChannel must call back once; ignore a second call
            settled = true;
            this.authorizing = false;
            if (this.cancelAuthorizedAttach) {
                // T17: Echo left the channel while it was authorizing; don't attach it now
                this.cancelAuthorizedAttach = false;
                error = error ?? new Error(`Attach of ${this.name} cancelled: the channel was left while authorizing`);
            }
            // Callers queued meanwhile settle with this attempt's outcome. Their attach() promises already have a
            // rejection handler (see the attach() wrapper below), so an ably-internal fire-and-forget attach()
            // (presence.enter/update on an 'initialized' channel, RTP8d) can't become an unhandled rejection (T18).
            const pending = this._pendingAttachCbs ?? [];
            this._pendingAttachCbs = [];
            if (error) {
                if (errCallback) {
                    errCallback(error);
                } else {
                    console.error(`channel ${this.name} auth error => ${error}`);
                }
                pending.forEach((cb) => cb?.(error));
                return;
            }
            internalAttach.call(this, forceReattach, attachReason, errCallback);
            // while 'attaching', internalAttach only registers another once-listener; no second ATTACH is sent
            pending.forEach((cb) => internalAttach.call(this, false, attachReason, cb));
        };
        try {
            authorizeChannel(this, done);
        } catch (e) {
            if (settled) throw e; // thrown after done() ran (e.g. by the library's attach): surface it, as before
            done(e); // T8: a sync throw must not leave `authorizing` stuck
        }
    }
    prototype._attach = customInternalAttach;

    // An attach() called while its channel authorizes is queued (above). Give its promise a rejection handler before
    // returning it: callers that await it still get the rejection, but a caller that ignores it, like ably's own
    // presence.enter/update on an 'initialized' channel, can't raise an unhandled rejection (T18).
    const internalAttachPromise = prototype.attach;
    if (typeof internalAttachPromise === 'function') {
        prototype.attach = function attach(...args) {
            const queued = !!this.authorizing && authorizers.has(this.client);
            const result = internalAttachPromise.apply(this, args);
            if (queued && typeof result?.catch === 'function') {
                result.catch(() => undefined);
            }
            return result;
        };
    }
    patchedPrototypes.add(prototype);
};
