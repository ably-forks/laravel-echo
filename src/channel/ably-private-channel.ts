import { AblyChannel } from './ably-channel';
import { AblyAuth } from './ably/auth';
import { safeInvoke } from './ably/utils';

export class AblyPrivateChannel extends AblyChannel {
    constructor(ably: any, name: string, options: any, auth: AblyAuth) {
        super(ably, name, options, false);
        if (auth) {
            // P3: no AblyAuth with options.client, so no 40160 re-authorize
            this.channel.on('failed', auth.onChannelFailed(this));
        }

        this.subscribe();
    }
    /**
     * Send a whisper event to other clients in the channel.
     */
    whisper(eventName: string, data: any, callback?: Function): AblyPrivateChannel {
        this.channel
            .publish(`client-${eventName}`, data)
            .then(
                () => safeInvoke(callback, null),
                (err) => (callback ? safeInvoke(callback, err) : this._alertErrorListeners(err))
            );
        return this;
    }
}
