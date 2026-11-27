import { AblyChannel } from "./ably-channel";
import type { AblyAuth } from "./ably/auth";
import { safeInvoke } from "./ably/utils";
import type { ErrorInfo } from "../types/ably";

export class AblyPrivateChannel extends AblyChannel {
    // any: the connector passes its Ably client and options; the parity tests pass fakes (SDK boundary)
    constructor(
        ably: any,
        name: string,
        options: any,
        auth: AblyAuth | undefined,
    ) {
        super(ably, name, options, false);
        if (auth) {
            // P3: no AblyAuth with options.client, so no 40160 re-authorize
            this.channel.on("failed", auth.onChannelFailed(this));
        }

        this.subscribe();
    }
    /**
     * Send a whisper event to other clients in the channel.
     */
    whisper(
        eventName: string,
        data: Record<any, any>,
        callback?: CallableFunction,
    ): this {
        this.channel.publish(`client-${eventName}`, data).then(
            () => safeInvoke(callback, null),
            (err: ErrorInfo | Error) =>
                callback
                    ? safeInvoke(callback, err)
                    : this._alertErrorListeners(err),
        );
        return this;
    }
}
