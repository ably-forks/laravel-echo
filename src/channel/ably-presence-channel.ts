import { AblyChannel } from './ably-channel';
import { AblyAuth } from './ably/auth';
import type { PresenceChannel } from './presence-channel';

/**
 * This class represents an Ably presence channel.
 */
export class AblyPresenceChannel extends AblyChannel implements PresenceChannel {
    presenceData: any;

    constructor(ably: any, name: string, options: any, auth: AblyAuth) {
        super(ably, name, options, false);
        this.channel.on('failed', auth.onChannelFailed(this));
        this.channel.on('attached', () => this.enter(this.presenceData, this._alertErrorListeners));
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
                    .then((members) => callback(members.map(({ data }) => data), null))
                    .catch((err) => callback([], err))
            )
            .catch(this._alertErrorListeners);
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
            .catch(this._alertErrorListeners);

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
            .catch(this._alertErrorListeners);

        return this;
    }

    /**
     * Enter presence
     * @param data - Data to be published while entering the channel
     * @param callback - success/error callback (err) => {}
     * @returns AblyPresenceChannel
     */
    enter(data: any, callback?: Function): AblyPresenceChannel {
        this.channel.presence
            .enter(data)
            .then(() => callback?.(null))
            .catch((err) => callback ? callback(err) : this._alertErrorListeners(err));

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
            .then(() => callback?.(null))
            .catch((err) => callback ? callback(err) : this._alertErrorListeners(err));

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
            .then(() => callback?.(null))
            .catch((err) => callback ? callback(err) : this._alertErrorListeners(err));

        return this;
    }

    /**
     * Send a whisper event to other clients in the channel.
     */
    whisper(eventName: string, data: any, callback?: Function): AblyPresenceChannel {
        this.channel
            .publish(`client-${eventName}`, data)
            .then(() => callback?.(null))
            .catch((err) => callback ? callback(err) : this._alertErrorListeners(err));
        return this;
    }
}
