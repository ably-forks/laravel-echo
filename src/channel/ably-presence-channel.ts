import { AblyChannel } from './ably-channel';
import { AblyAuth } from './ably/auth';
import type { PresenceChannel } from './presence-channel';
import { safeInvoke } from './ably/utils';

/**
 * This class represents an Ably presence channel.
 */
export class AblyPresenceChannel extends AblyChannel implements PresenceChannel {
    presenceData: any;

    /**
     * Outcome of the last enter(): true or false once it settled, undefined while one is in flight. Starts false, so a
     * client that never entered is treated like one whose enter failed.
     */
    lastEnterSucceeded: boolean | undefined = false;

    constructor(ably: any, name: string, options: any, auth: AblyAuth) {
        super(ably, name, options, false);
        if (auth) {
            // P3: no AblyAuth with options.client, so no 40160 re-authorize
            this.channel.on('failed', auth.onChannelFailed(this));
        }

        this.channel.on('attached', (stateChange) => {
            // T15: on a resumed attach the server kept our membership and ably re-enters it (RTP17); don't enter twice.
            // If the last enter() failed there is no membership to restore, so enter again.
            if (!stateChange?.resumed || this.lastEnterSucceeded === false) {
                this.enter(this.presenceData, this._alertErrorListeners);
            }
        });
        this.subscribe();
    }

    unsubscribe(): void {
        this.leave(this.presenceData, this._alertErrorListeners);
        this.channel.presence.unsubscribe();
        super.unsubscribe();
    }

    /**
     * Register a callback to be called anytime the member list changes.
     */
    here(callback: Function): AblyPresenceChannel {
        this.channel.presence
            .subscribe(['enter', 'update', 'leave'], () =>
                this.channel.presence
                    .get()
                    .then(
                        (members) => safeInvoke(callback, members.map(({ data }) => data), null),
                        (err) => safeInvoke(callback, [], err)
                    )
            )
            .catch(this._subscribeErrorHandler());
        return this;
    }

    /**
     * Listen for someone joining the channel.
     */
    joining(callback: Function): AblyPresenceChannel {
        this.channel.presence
            .subscribe(['enter', 'update'], ({ data, ...metaData }) => {
                callback(data, metaData);
            })
            .catch(this._subscribeErrorHandler());

        return this;
    }

    /**
     * Listen for someone leaving the channel.
     */
    leaving(callback: Function): AblyPresenceChannel {
        this.channel.presence
            .subscribe('leave', ({ data, ...metaData }) => {
                callback(data, metaData);
            })
            .catch(this._subscribeErrorHandler());

        return this;
    }

    /**
     * Enter presence
     * @param data - Data to be published while entering the channel
     * @param callback - success/error callback (err) => {}
     * @returns AblyPresenceChannel
     */
    enter(data: any, callback?: Function): AblyPresenceChannel {
        this.lastEnterSucceeded = undefined;
        this.channel.presence
            .enter(data)
            .then(
                () => {
                    this.lastEnterSucceeded = true;
                    safeInvoke(callback, null);
                },
                (err) => {
                    this.lastEnterSucceeded = false;
                    if (callback) {
                        safeInvoke(callback, err);
                    } else {
                        this._alertErrorListeners(err);
                    }
                }
            );

        return this;
    }

    /**
     * Leave presence
     * @param data - Data to be published while leaving the channel
     * @param callback - success/error callback (err) => {}
     * @returns AblyPresenceChannel
     */
    leave(data: any, callback?: Function): AblyPresenceChannel {
        this.channel.presence
            .leave(data)
            .then(
                () => safeInvoke(callback, null),
                (err) => (callback ? safeInvoke(callback, err) : this._alertErrorListeners(err))
            );

        return this;
    }

    /**
     * Update presence
     * @param data - Update presence with data
     * @param callback - success/error callback (err) => {}
     * @returns AblyPresenceChannel
     */
    update(data: any, callback?: Function): AblyPresenceChannel {
        this.channel.presence
            .update(data)
            .then(
                () => safeInvoke(callback, null),
                (err) => (callback ? safeInvoke(callback, err) : this._alertErrorListeners(err))
            );

        return this;
    }

    /**
     * Send a whisper event to other clients in the channel.
     */
    whisper(eventName: string, data: any, callback?: Function): AblyPresenceChannel {
        this.channel
            .publish(`client-${eventName}`, data)
            .then(
                () => safeInvoke(callback, null),
                (err) => (callback ? safeInvoke(callback, err) : this._alertErrorListeners(err))
            );
        return this;
    }
}
