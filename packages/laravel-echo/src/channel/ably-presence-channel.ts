import { AblyChannel } from "./ably-channel";
import type { AblyAuth } from "./ably/auth";
import type { PresenceChannel } from "./presence-channel";
import { safeInvoke } from "./ably/utils";
import type { ErrorInfo, PresenceMessage } from "../types/ably";

/**
 * This class represents an Ably presence channel.
 */
export class AblyPresenceChannel
    extends AblyChannel
    implements PresenceChannel
{
    /**
     * The member data from the auth response (`info`), used on enter(). any: its shape is defined by the app.
     */
    presenceData: any;

    /**
     * Outcome of the last enter(): true or false once it settled, undefined while one is in flight. Starts false, so a
     * client that never entered is treated like one whose enter failed.
     */
    lastEnterSucceeded: boolean | undefined = false;

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

        this.channel.on("attached", (stateChange) => {
            // T15: on a resumed attach the server kept our membership and ably re-enters it (RTP17); don't enter twice.
            // If the last enter() failed there is no membership to restore, so enter again.
            if (!stateChange?.resumed || this.lastEnterSucceeded === false) {
                // E4: a failure of this enter() that the channel state change already reported (or that E3 swallowed
                // during an identity switch) is not reported again; the count scopes that to this attempt
                const stateChangeReasonsBefore = this.stateChangeReasonCount;
                this.enter(
                    this.presenceData,
                    (err: ErrorInfo | Error | null) =>
                        err &&
                        this._alertSubscribeError(
                            err,
                            stateChangeReasonsBefore,
                        ),
                );
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
    here(callback: CallableFunction): this {
        this.channel.presence
            .subscribe(["enter", "update", "leave"], () =>
                this.channel.presence.get().then(
                    (members: PresenceMessage[]) =>
                        safeInvoke(
                            callback,
                            members.map(({ data }) => data),
                            null,
                        ),
                    (err: ErrorInfo | Error) => safeInvoke(callback, [], err),
                ),
            )
            .catch(this._subscribeErrorHandler());
        return this;
    }

    /**
     * Listen for someone joining the channel.
     */
    joining(callback: CallableFunction): this {
        this.channel.presence
            .subscribe(
                ["enter", "update"],
                ({ data, ...metaData }: PresenceMessage) => {
                    callback(data, metaData);
                },
            )
            .catch(this._subscribeErrorHandler());

        return this;
    }

    /**
     * Listen for someone leaving the channel.
     */
    leaving(callback: CallableFunction): this {
        this.channel.presence
            .subscribe("leave", ({ data, ...metaData }: PresenceMessage) => {
                callback(data, metaData);
            })
            .catch(this._subscribeErrorHandler());

        return this;
    }

    /**
     * Enter presence
     * @param data - Data to be published while entering the channel
     * @param callback - success/error callback (err) => {}
     * @returns this channel
     */
    enter(data: unknown, callback?: CallableFunction): this {
        this.lastEnterSucceeded = undefined;
        this.channel.presence.enter(data).then(
            () => {
                this.lastEnterSucceeded = true;
                safeInvoke(callback, null);
            },
            (err: ErrorInfo | Error) => {
                this.lastEnterSucceeded = false;
                if (callback) {
                    safeInvoke(callback, err);
                } else {
                    this._alertErrorListeners(err);
                }
            },
        );

        return this;
    }

    /**
     * Leave presence
     * @param data - Data to be published while leaving the channel
     * @param callback - success/error callback (err) => {}
     * @returns this channel
     */
    leave(data: unknown, callback?: CallableFunction): this {
        this.channel.presence.leave(data).then(
            () => safeInvoke(callback, null),
            (err: ErrorInfo | Error) =>
                callback
                    ? safeInvoke(callback, err)
                    : this._alertErrorListeners(err),
        );

        return this;
    }

    /**
     * Update presence
     * @param data - Update presence with data
     * @param callback - success/error callback (err) => {}
     * @returns this channel
     */
    update(data: unknown, callback?: CallableFunction): this {
        this.channel.presence.update(data).then(
            () => safeInvoke(callback, null),
            (err: ErrorInfo | Error) =>
                callback
                    ? safeInvoke(callback, err)
                    : this._alertErrorListeners(err),
        );

        return this;
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
