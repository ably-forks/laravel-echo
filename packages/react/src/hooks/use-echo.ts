import type Echo from "@ably/laravel-echo";
import {
    type BroadcastDriver,
    type ConnectionStatus,
} from "@ably/laravel-echo";
import {
    type DependencyList,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { echo } from "../config";
import type {
    BroadcastNotification,
    Channel,
    ChannelData,
    ChannelReturnType,
    Connection,
    EventName,
    InferEventPayload,
    ModelEvents,
    ModelPayload,
} from "../types";
import { toArray } from "../util";

const channels: Record<string, ChannelData<BroadcastDriver>> = {};

// fork (F-082): the Echo instance the registry's subscriptions belong to, as in the Svelte package
let activeEchoInstance: Echo<BroadcastDriver> | null = null;

const clearChannelCache = (): void => {
    Object.keys(channels).forEach((channelId) => {
        delete channels[channelId];
    });
};

/**
 * fork (F-082): start the registry over when echo() returns another instance than the one its subscriptions
 * belong to; configureEcho() has already left every channel of the instance it replaced.
 */
const syncChannelCache = <T extends BroadcastDriver>(): Echo<T> => {
    const instance = echo<T>();

    if (
        activeEchoInstance !== null &&
        activeEchoInstance !== (instance as Echo<BroadcastDriver>)
    ) {
        clearChannelCache();
    }

    activeEchoInstance = instance;

    return instance;
};

const subscribeToChannel = <T extends BroadcastDriver>(
    channel: Channel,
): Connection<T> => {
    const instance = echo<T>();

    if (channel.visibility === "presence") {
        return instance.join(channel.name);
    }

    if (channel.visibility === "private") {
        return instance.private(channel.name);
    }

    return instance.channel(channel.name);
};

const leaveChannel = (channel: Channel, leaveAll: boolean): void => {
    if (!channels[channel.id]) {
        return;
    }

    // fork (F-082): after a reconfiguration the entry is gone; configureEcho() left its channel on the old instance
    syncChannelCache();

    if (!channels[channel.id]) {
        return;
    }

    channels[channel.id].count -= 1;

    if (channels[channel.id].count > 0) {
        return;
    }

    if (leaveAll) {
        echo().leave(channel.name);
    } else {
        // fork (provisional: P-04): the core builds the connector's full name (Ably: "private:x"; others: "private-x")
        echo().leaveChannel(channel.name, channel.visibility);
    }

    delete channels[channel.id];
};

const resolveChannelSubscription = <T extends BroadcastDriver>(
    channel: Channel,
): Connection<T> => {
    syncChannelCache();

    if (channels[channel.id]) {
        channels[channel.id].count += 1;

        return channels[channel.id].connection;
    }

    const channelSubscription = subscribeToChannel<T>(channel);

    channels[channel.id] = {
        count: 1,
        connection: channelSubscription,
    };

    return channelSubscription;
};

// Overload for automatic type inference from event name
export function useEcho<
    TEvent extends EventName = EventName,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: string,
    event: TEvent,
    callback: (payload: InferEventPayload<TEvent>) => void,
    dependencies?: DependencyList,
    visibility?: TVisibility,
): {
    leaveChannel: (leaveAll?: boolean) => void;
    leave: () => void;
    stopListening: () => void;
    listen: () => void;
    channel: () => ChannelReturnType<TDriver, TVisibility> | null;
};

// Overload for multiple events with automatic type inference
export function useEcho<
    TEvent extends EventName = EventName,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: string,
    event: TEvent[],
    callback: (payload: InferEventPayload<TEvent>) => void,
    dependencies?: DependencyList,
    visibility?: TVisibility,
): {
    leaveChannel: (leaveAll?: boolean) => void;
    leave: () => void;
    stopListening: () => void;
    listen: () => void;
    channel: () => ChannelReturnType<TDriver, TVisibility> | null;
};

// Overload for explicit payload type (backward compatibility)
export function useEcho<
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: string,
    event?: string | string[],
    callback?: (payload: TPayload) => void,
    dependencies?: DependencyList,
    visibility?: TVisibility,
): {
    leaveChannel: (leaveAll?: boolean) => void;
    leave: () => void;
    stopListening: () => void;
    listen: () => void;
    channel: () => ChannelReturnType<TDriver, TVisibility> | null;
};

// Implementation
export function useEcho<
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
    TVisibility extends Channel["visibility"] = "private",
>(
    channelName: string,
    event: string | string[] = [],
    callback: (payload: TPayload) => void = () => {},
    dependencies: DependencyList = [],
    visibility: TVisibility = "private" as TVisibility,
) {
    const channel: Channel = useMemo(
        () => ({
            name: channelName,
            // fork (provisional: P-04): one key format for every visibility, so a public channel named
            // "private-x" and the private channel "x" no longer share a registry entry
            id: `${visibility}:${channelName}`,
            visibility,
        }),
        [channelName, visibility],
    );

    // callback and dependencies are parameters meant to be used directly
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
    const callbackFunc = useCallback(callback, dependencies);
    const listening = useRef(false);
    const subscription = useRef<Connection<TDriver> | null>(null);

    const eventKey = Array.isArray(event) ? JSON.stringify(event) : event;
    // Using eventKey instead of event to stabilize array dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const events = useMemo(() => toArray(event), [eventKey]);

    const stopListening = useCallback(() => {
        if (!listening.current || !subscription.current) {
            return;
        }

        events.forEach((e) => {
            subscription.current!.stopListening(e, callbackFunc);
        });

        listening.current = false;
    }, [events, callbackFunc]);

    const listen = useCallback(() => {
        if (listening.current || !subscription.current) {
            return;
        }

        events.forEach((e) => {
            subscription.current!.listen(e, callbackFunc);
        });

        listening.current = true;
    }, [events, callbackFunc]);

    const tearDown = useCallback(
        (leaveAll: boolean = false) => {
            stopListening();

            leaveChannel(channel, leaveAll);
        },
        [stopListening, channel],
    );

    const leave = useCallback(() => {
        tearDown(true);
    }, [tearDown]);

    useEffect(() => {
        subscription.current = resolveChannelSubscription<TDriver>(channel);

        listen();

        return tearDown;
    }, [listen, tearDown, channel]);

    return useMemo(
        () => ({
            /**
             * Leave the channel
             */
            leaveChannel: tearDown,
            /**
             * Leave the channel and also its associated private and presence channels
             */
            leave,
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
            channel: () =>
                subscription.current as ChannelReturnType<
                    TDriver,
                    TVisibility
                > | null,
        }),
        [leave, listen, stopListening, tearDown],
    );
}

export const useEchoNotification = <
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: string,
    callback: (payload: BroadcastNotification<TPayload>) => void = () => {},
    event: string | string[] = [],
    dependencies: DependencyList = [],
) => {
    const result = useEcho<BroadcastNotification<TPayload>, TDriver, "private">(
        channelName,
        [],
        callback,
        dependencies,
        "private",
    );

    const eventKey = Array.isArray(event) ? JSON.stringify(event) : event;
    const events = useMemo(() => {
        return toArray(event)
            .map((e) => {
                if (e.includes(".")) {
                    return [e, e.replace(/\./g, "\\")];
                }

                return [e, e.replace(/\\/g, ".")];
            })
            .flat();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventKey]);

    const listening = useRef(false);

    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
    const memoizedCallback = useCallback(callback, dependencies);

    const cb = useCallback(
        (notification: BroadcastNotification<TPayload>) => {
            if (!listening.current) {
                return;
            }

            if (events.length === 0 || events.includes(notification.type)) {
                memoizedCallback(notification);
            }
        },
        [memoizedCallback, events],
    );

    const listen = useCallback(() => {
        if (listening.current) {
            return;
        }

        const ch = result.channel();

        if (!ch) {
            return;
        }

        ch.notification(cb);

        listening.current = true;
    }, [cb, result]);

    const stopListening = useCallback(() => {
        if (!listening.current) {
            return;
        }

        const ch = result.channel();

        if (!ch) {
            listening.current = false;
            return;
        }

        ch.stopListeningForNotification(cb);

        listening.current = false;
    }, [cb, result]);

    useEffect(() => {
        listen();

        return () => stopListening();
    }, [listen, stopListening]);

    return useMemo(
        () => ({
            ...result,
            /**
             * Stop listening for notification events
             */
            stopListening,
            /**
             * Listen for notification events
             */
            listen,
        }),
        [result, stopListening, listen],
    );
};

export const useEchoPresence = <
    TPayload,
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: string,
    event: string | string[] = [],
    callback: (payload: TPayload) => void = () => {},
    dependencies: DependencyList = [],
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
    channelName: string,
    event: string | string[] = [],
    callback: (payload: TPayload) => void = () => {},
    dependencies: DependencyList = [],
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
>(channelName: string, visibility: TVisibility = "private" as TVisibility) {
    const channel: Channel = useMemo(
        () => ({
            name: channelName,
            // fork (provisional: P-04): one key format for every visibility, so a public channel named
            // "private-x" and the private channel "x" no longer share a registry entry
            id: `${visibility}:${channelName}`,
            visibility,
        }),
        [channelName, visibility],
    );

    const subscription = useRef<Connection<TDriver> | null>(null);

    const tearDown = useCallback(
        (leaveAll: boolean = false) => {
            leaveChannel(channel, leaveAll);
        },
        [channel],
    );

    const leave = useCallback(() => {
        tearDown(true);
    }, [tearDown]);

    useEffect(() => {
        subscription.current = resolveChannelSubscription<TDriver>(channel);

        return () => tearDown();
    }, [tearDown, channel]);

    return useMemo(
        () => ({
            /**
             * Leave the channel
             */
            leaveChannel: tearDown,
            /**
             * Leave the channel and also its associated private and presence channels
             */
            leave,
            /**
             * Channel instance
             */
            channel: () =>
                subscription.current as ChannelReturnType<
                    TDriver,
                    TVisibility
                > | null,
        }),
        [leave, tearDown],
    );
}

export const usePresenceChannel = <
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: string,
) => {
    return useChannel<TDriver, "presence">(channelName, "presence");
};

export const usePublicChannel = <
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    channelName: string,
) => {
    return useChannel<TDriver, "public">(channelName, "public");
};

export const useEchoModel = <
    TPayload,
    TModel extends string,
    TDriver extends BroadcastDriver = BroadcastDriver,
>(
    model: TModel,
    identifier: string | number,
    event: ModelEvents<TModel> | ModelEvents<TModel>[] = [],
    callback: (payload: ModelPayload<TPayload>) => void = () => {},
    dependencies: DependencyList = [],
) => {
    return useEcho<ModelPayload<TPayload>, TDriver, "private">(
        `${model}.${identifier}`,
        toArray(event).map((e) => (e.startsWith(".") ? e : `.${e}`)),
        callback,
        dependencies,
        "private",
    );
};

const useConnectionChange = (
    callback: (status: ConnectionStatus) => void,
    invokeOnMount: boolean = true,
): void => {
    const callbackRef = useRef(callback);

    useLayoutEffect(() => {
        callbackRef.current = callback;
    });

    useEffect(() => {
        if (invokeOnMount) {
            callbackRef.current(echo().connectionStatus());
        }

        // fork (provisional: P-03): Echo's registry survives Echo.connect() replacing the connector
        return echo().onConnectionChange((status) =>
            callbackRef.current(status),
        );
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
};

export const useConnectionStatus = (): ConnectionStatus => {
    const [status, setStatus] = useState<ConnectionStatus>(() =>
        echo().connectionStatus(),
    );

    useConnectionChange((newStatus) => {
        setStatus(newStatus);
    });

    return status;
};

export const useSocketId = (): string | undefined => {
    const [socketId, setSocketId] = useState<string | undefined>(() =>
        echo().socketId(),
    );

    useConnectionChange(() => {
        setSocketId(echo().socketId());
    }, false);

    return socketId;
};
