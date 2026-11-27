import type Echo from "@ably/laravel-echo";
import {
    type BroadcastDriver,
    type ConnectionStatus,
} from "@ably/laravel-echo";
import { channelRegistryId, echo } from "../config";
import type {
    BroadcastNotification,
    CallbackInput,
    Channel,
    ChannelData,
    ChannelReturnType,
    Connection,
    Dependency,
    EventName,
    InferEventPayload,
    ModelEvents,
    ModelPayload,
    ReactiveInput,
} from "../types";
import { toArray } from "../util";

const channels: Record<string, ChannelData<BroadcastDriver>> = {};
let activeEchoInstance: Echo<BroadcastDriver> | null = null;

/**
 * fork (P-09): whether the rune runs inside svelte/server's render(). The runes ship compiled for the client, and
 * the client runtime has no effect context there, so $effect throws effect_orphan: that is the exact signal. A
 * browser (`window` defined) skips the probe and behaves as upstream. A client runtime without `window` (a Web
 * Worker, a custom renderer, Node tests with $effect.root) has an effect context, so it subscribes as upstream; the
 * probe leaves a no-op effect there. Only a rune called outside any effect without `window` reads as a server render.
 */
const isServerRender = (): boolean => {
    if (typeof window !== "undefined") {
        return false;
    }

    try {
        $effect(() => {});

        return false;
    } catch (error) {
        if (error instanceof Error && error.message.includes("effect_orphan")) {
            return true;
        }

        throw error;
    }
};

// fork (P-09): $effect, except during server rendering, where the client runtime cannot run effects
const clientEffect = (
    serverRender: boolean,
    fn: () => void | (() => void),
): void => {
    if (serverRender) {
        return;
    }

    $effect(fn);
};

const clearChannelCache = (): void => {
    Object.keys(channels).forEach((channelId) => {
        delete channels[channelId];
    });
};

const resolveChannelSubscription = <T extends BroadcastDriver>(
    channel: Channel,
): Connection<T> => {
    const instance = echo<T>();

    if (
        activeEchoInstance !== null &&
        activeEchoInstance !== (instance as Echo<BroadcastDriver>)
    ) {
        clearChannelCache();
    }

    activeEchoInstance = instance;

    if (channels[channel.id]) {
        channels[channel.id].count += 1;

        return channels[channel.id].connection;
    }

    const channelSubscription = subscribeToChannel<T>(instance, channel);

    channels[channel.id] = {
        count: 1,
        connection: channelSubscription,
    };

    return channelSubscription;
};

const subscribeToChannel = <T extends BroadcastDriver>(
    instance: Echo<T>,
    channel: Channel,
): Connection<T> => {
    if (channel.visibility === "presence") {
        return instance.join(channel.name);
    }

    if (channel.visibility === "private") {
        return instance.private(channel.name);
    }

    return instance.channel(channel.name);
};

const leaveChannel = (
    channel: Channel,
    leaveAll: boolean = false,
    connection?: unknown,
): void => {
    if (!channels[channel.id]) {
        return;
    }

    // fork (UB-15, provisional): the entry belongs to another hook's subscription when this hook already left and a
    // sibling subscribed the channel again; releasing it would leave the channel under the sibling
    if (connection && channels[channel.id].connection !== connection) {
        return;
    }

    channels[channel.id].count -= 1;

    if (channels[channel.id].count > 0) {
        return;
    }

    delete channels[channel.id];

    if (leaveAll) {
        echo().leave(channel.name);
    } else {
        // fork (provisional: P-04): the core builds the connector's full name (Ably: "private:x"; others: "private-x")
        echo().leaveChannel(channel.name, channel.visibility);
    }
};

const trackDependencies = (dependencies: Dependency[]): void => {
    dependencies.forEach((dependency) => {
        if (typeof dependency === "function") {
            const getter = dependency as () => unknown;

            void getter();

            return;
        }

        void dependency;
    });
};

const resolveInput = <T>(input: ReactiveInput<T>): T => {
    if (typeof input === "function") {
        return (input as () => T)();
    }

    return input;
};

const resolveCallback = <TPayload>(
    callback: CallbackInput<TPayload>,
): ((payload: TPayload) => void) => {
    if (typeof callback === "function") {
        return callback;
    }

    return callback.current;
};

const resolveChannel = <TVisibility extends Channel["visibility"]>(
    channelName: ReactiveInput<string>,
    visibility: TVisibility,
): Channel => {
    const resolvedChannelName = resolveInput(channelName);

    return {
        name: resolvedChannelName,
        // fork (provisional: P-04; UB-19): upstream's id for non-Ably drivers, per visibility for Ably
        id: channelRegistryId(resolvedChannelName, visibility),
        visibility,
    };
};

// Overload for automatic type inference from event name
export function useEcho<
    TEvent extends EventName = EventName,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: ReactiveInput<string>,
    event: ReactiveInput<TEvent>,
    callback: CallbackInput<InferEventPayload<TEvent>>,
    dependencies?: Dependency[],
    visibility?: TVisibility,
): {
    leaveChannel: (leaveAll?: boolean) => void;
    leave: () => void;
    stopListening: () => void;
    listen: () => void;
    channel: () => ChannelReturnType<TDriver, TVisibility>;
};

// Overload for multiple events with automatic type inference
export function useEcho<
    TEvent extends EventName = EventName,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: ReactiveInput<string>,
    event: ReactiveInput<TEvent[]>,
    callback: CallbackInput<InferEventPayload<TEvent>>,
    dependencies?: Dependency[],
    visibility?: TVisibility,
): {
    leaveChannel: (leaveAll?: boolean) => void;
    leave: () => void;
    stopListening: () => void;
    listen: () => void;
    channel: () => ChannelReturnType<TDriver, TVisibility>;
};

// Overload for explicit payload type (backward compatibility)
export function useEcho<
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: ReactiveInput<string>,
    event?: ReactiveInput<string | string[]>,
    callback?: CallbackInput<TPayload>,
    dependencies?: Dependency[],
    visibility?: TVisibility,
): {
    leaveChannel: (leaveAll?: boolean) => void;
    leave: () => void;
    stopListening: () => void;
    listen: () => void;
    channel: () => ChannelReturnType<TDriver, TVisibility>;
};

// Implementation
export function useEcho<
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: ReactiveInput<string>,
    event: ReactiveInput<string | string[]> = [],
    callback: CallbackInput<TPayload> = () => {},
    dependencies: Dependency[] = [],
    visibility: TVisibility = "private" as TVisibility,
) {
    let listening = false;
    let initialized = false;
    let channel = resolveChannel(channelName, visibility);
    let events = toArray(resolveInput(event));
    // fork (P-09): no subscription during server rendering, so channel() returns null there
    const serverRender = isServerRender();
    let subscription = (
        serverRender ? null : resolveChannelSubscription<TDriver>(channel)
    ) as Connection<TDriver>;

    const eventCallback = (payload: TPayload) => {
        resolveCallback(callback)(payload);
    };

    const listen = () => {
        if (listening) {
            return;
        }

        events.forEach((e) => {
            subscription.listen(e, eventCallback);
        });

        listening = true;
    };

    const stopListening = () => {
        if (!listening) {
            return;
        }

        events.forEach((e) => {
            subscription.stopListening(e, eventCallback);
        });

        listening = false;
    };

    const tearDown = (leaveAll: boolean = false) => {
        stopListening();
        leaveChannel(channel, leaveAll, subscription);
    };

    clientEffect(serverRender, () => {
        trackDependencies(dependencies);
        channel = resolveChannel(channelName, visibility);
        events = toArray(resolveInput(event));

        if (initialized) {
            subscription = resolveChannelSubscription<TDriver>(channel);
        }

        initialized = true;
        listen();

        return () => tearDown();
    });

    return {
        /**
         * Leave the channel
         */
        leaveChannel: tearDown,
        /**
         * Leave the channel and also its associated private and presence channels
         */
        leave: () => tearDown(true),
        /**
         * Stop listening for event(s) without leaving the channel
         */
        stopListening,
        /**
         * Listen for event(s)
         */
        listen,
        /**
         * Channel instance
         */
        channel: () => subscription as ChannelReturnType<TDriver, TVisibility>,
    };
}

export const useEchoNotification = <
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: ReactiveInput<string>,
    callback: CallbackInput<BroadcastNotification<TPayload>> = () => {},
    event: ReactiveInput<string | string[]> = [],
    dependencies: Dependency[] = [],
) => {
    const result = useEcho<BroadcastNotification<TPayload>, TDriver, "private">(
        channelName,
        [],
        callback,
        dependencies,
        "private",
    );

    let listening = false;
    let events = toArray(resolveInput(event))
        .map((e) => {
            if (e.includes(".")) {
                return [e, e.replace(/\./g, "\\")];
            }

            return [e, e.replace(/\\/g, ".")];
        })
        .flat();

    const cb = (notification: BroadcastNotification<TPayload>) => {
        if (!listening) {
            return;
        }

        if (events.length === 0 || events.includes(notification.type)) {
            resolveCallback(callback)(notification);
        }
    };

    const listen = () => {
        if (listening) {
            return;
        }

        result.channel().notification(cb);

        listening = true;
    };

    const stopListening = () => {
        if (!listening) {
            return;
        }

        result.channel().stopListeningForNotification(cb);
        listening = false;
    };

    clientEffect(isServerRender(), () => {
        trackDependencies(dependencies);
        events = toArray(resolveInput(event))
            .map((e) => {
                if (e.includes(".")) {
                    return [e, e.replace(/\./g, "\\")];
                }

                return [e, e.replace(/\\/g, ".")];
            })
            .flat();

        listen();

        return () => stopListening();
    });

    return {
        ...result,
        /**
         * Stop listening for notification events
         */
        stopListening,
        /**
         * Listen for notification events
         */
        listen,
    };
};

export const useEchoPresence = <
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: ReactiveInput<string>,
    event: ReactiveInput<string | string[]> = [],
    callback: CallbackInput<TPayload> = () => {},
    dependencies: Dependency[] = [],
) => {
    return useEcho<TPayload, TDriver, "presence">(
        channelName,
        event,
        callback,
        dependencies,
        "presence",
    );
};

export const useEchoPublic = <
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: ReactiveInput<string>,
    event: ReactiveInput<string | string[]> = [],
    callback: CallbackInput<TPayload> = () => {},
    dependencies: Dependency[] = [],
) => {
    return useEcho<TPayload, TDriver, "public">(
        channelName,
        event,
        callback,
        dependencies,
        "public",
    );
};

export function useChannel<
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: ReactiveInput<string>,
    visibility: TVisibility = "private" as TVisibility,
) {
    let initialized = false;
    let channel = resolveChannel(channelName, visibility);
    // fork (P-09): no subscription during server rendering, so channel() returns null there
    const serverRender = isServerRender();
    let subscription = (
        serverRender ? null : resolveChannelSubscription<TDriver>(channel)
    ) as Connection<TDriver>;

    const tearDown = (leaveAll: boolean = false) => {
        leaveChannel(channel, leaveAll, subscription);
    };

    clientEffect(serverRender, () => {
        channel = resolveChannel(channelName, visibility);

        // fork (F-374): the first run keeps the subscription made at init, as useEcho does. Resolving
        // it again counted the hook twice in the registry, so unmounting it never left the channel.
        if (initialized) {
            subscription = resolveChannelSubscription<TDriver>(channel);
        }

        initialized = true;

        return () => tearDown();
    });

    return {
        /**
         * Leave the channel
         */
        leaveChannel: tearDown,
        /**
         * Leave the channel and also its associated private and presence channels
         */
        leave: () => tearDown(true),
        /**
         * Channel instance
         */
        channel: () => subscription as ChannelReturnType<TDriver, TVisibility>,
    };
}

export const usePresenceChannel = <
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: ReactiveInput<string>,
) => {
    return useChannel<TDriver, "presence">(channelName, "presence");
};

export const usePublicChannel = <
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: ReactiveInput<string>,
) => {
    return useChannel<TDriver, "public">(channelName, "public");
};

export const useEchoModel = <
    TPayload,
    TModel extends string,
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    model: ReactiveInput<TModel>,
    identifier: ReactiveInput<string | number>,
    event: ReactiveInput<ModelEvents<TModel> | ModelEvents<TModel>[]> = [],
    callback: CallbackInput<ModelPayload<TPayload>> = () => {},
    dependencies: Dependency[] = [],
) => {
    return useEcho<ModelPayload<TPayload>, TDriver, "private">(
        () => `${resolveInput(model)}.${resolveInput(identifier)}`,
        () =>
            toArray(resolveInput(event)).map((e) =>
                e.startsWith(".") ? e : `.${e}`,
            ),
        callback,
        dependencies,
        "private",
    );
};

const useConnectionChange = (
    callback: (status: ConnectionStatus) => void,
    invokeOnMount: boolean = true,
    serverRender: boolean = false,
): void => {
    clientEffect(serverRender, () => {
        if (invokeOnMount) {
            callback(echo().connectionStatus());
        }

        // fork (provisional: P-03): Echo's registry survives Echo.connect() replacing the connector
        const unsubscribe = echo().onConnectionChange(callback);

        return () => unsubscribe();
    });
};

export const useConnectionStatus = (): (() => ConnectionStatus) => {
    // fork (P-09): "disconnected" during server rendering, without creating Echo there
    const serverRender = isServerRender();
    let status = $state<ConnectionStatus>(
        serverRender ? "disconnected" : echo().connectionStatus(),
    );

    useConnectionChange(
        (newStatus) => {
            status = newStatus;
        },
        true,
        serverRender,
    );

    return () => status;
};

export const useSocketId = (): (() => string | undefined) => {
    // fork (P-09): undefined during server rendering, without creating Echo there
    const serverRender = isServerRender();
    let socketId = $state<string | undefined>(
        serverRender ? undefined : echo().socketId(),
    );

    useConnectionChange(
        () => {
            socketId = echo().socketId();
        },
        false,
        serverRender,
    );

    return () => socketId;
};
