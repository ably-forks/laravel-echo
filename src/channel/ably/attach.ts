import { isNullOrUndefined } from './utils';

/** Echo's authorize function per ably client: only clients Echo created go through the pre-attach authorize. */
const authorizers = new WeakMap<object, Function>();

/** RealtimeChannel prototypes whose _attach is patched; each ably build (node, browser, debug, ...) has its own. */
const patchedPrototypes = new WeakSet<object>();

const PROBE_CHANNEL = 'dummy';

/**
 * Modifies existing channel attach with custom authz implementation, for the given client only.
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
            if (error) {
                // Only the attach that started this authorization gets the error. Callbacks queued meanwhile stay
                // queued for the next attempt (as before the fix): some come from ably-internal fire-and-forget
                // attach() calls (e.g. presence.enter() on an 'initialized' channel, v3 node.js:8630), and
                // rejecting those raises an unhandled promise rejection.
                if (errCallback) {
                    errCallback(error);
                } else {
                    console.error(`channel ${this.name} auth error => ${error}`);
                }
                return;
            }
            const pending = this._pendingAttachCbs ?? [];
            this._pendingAttachCbs = [];
            internalAttach.call(this, forceReattach, attachReason, errCallback);
            // while 'attaching', internalAttach only registers another once-listener; no second ATTACH is sent.
            // Queued callers are only ever resolved: some are ably-internal fire-and-forget attach() calls
            // (presence.enter/update on an 'initialized' channel, RTP8d) whose rejection would be unhandled.
            // On an attach failure keep them queued for the next attempt, as on an authorization failure.
            pending.forEach((cb) =>
                internalAttach.call(this, false, attachReason, (err, result) =>
                    err ? (this._pendingAttachCbs ??= []).push(cb) : cb?.(null, result)
                )
            );
        };
        try {
            authorizeChannel(this, done);
        } catch (e) {
            if (settled) throw e; // thrown after done() ran (e.g. by the library's attach): surface it, as before
            done(e); // T8: a sync throw must not leave `authorizing` stuck
        }
    }
    prototype._attach = customInternalAttach;
    patchedPrototypes.add(prototype);
};
