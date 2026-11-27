import Echo, {
    type BroadcastDriver,
    type Broadcaster,
    type EchoOptions,
} from "@ably/laravel-echo";
import type { ConfigDefaults } from "../types";

/**
 * The Echo constructor argument, which allows a custom connector class as the broadcaster.
 */
type EchoConfig = ConstructorParameters<typeof Echo<keyof Broadcaster>>[0];

let echoInstance: Echo<keyof Broadcaster> | null = null;
let echoConfig: EchoConfig | null = null;

/**
 * fork (P-07): unlike upstream, the adapters neither import nor inject pusher-js, so the Pusher and Reverb
 * broadcasters use the app's own copy. Without one, fail with a hint that names both ways to provide it, instead
 * of the core's generic "Pusher client not found" (the checks mirror PusherConnector.connect()).
 */
const assertPusherAvailable = (config: EchoConfig): void => {
    const { broadcaster } = config;

    if (broadcaster !== "pusher" && broadcaster !== "reverb") {
        return;
    }

    const windowPusher: unknown =
        typeof window === "undefined"
            ? undefined
            : (window as unknown as { Pusher?: unknown }).Pusher;

    if (
        config.Pusher ||
        typeof config.client !== "undefined" ||
        typeof windowPusher !== "undefined"
    ) {
        return;
    }

    throw new Error(
        `The "${broadcaster}" broadcaster needs the Pusher class from pusher-js, which @ably/laravel-echo-vue ` +
            `does not bundle. Pass it in the options, configureEcho({ broadcaster: "${broadcaster}", Pusher }), ` +
            `or set window.Pusher = Pusher before Echo is used.`,
    );
};

const getEchoInstance = <T extends keyof Broadcaster>(): Echo<T> => {
    if (echoInstance) {
        return echoInstance as Echo<T>;
    }

    if (!echoConfig) {
        throw new Error(
            "Echo has not been configured. Please call `configureEcho()` with your configuration options before using Echo.",
        );
    }

    assertPusherAvailable(echoConfig);

    echoInstance = new Echo<keyof Broadcaster>(echoConfig);

    return echoInstance as Echo<T>;
};

export const echoIsConfigured = () => echoConfig !== null;

/**
 * Configure the Echo instance with sensible defaults.
 *
 * `broadcaster` accepts a built-in driver name or a custom connector class.
 *
 * @link https://laravel.com/docs/broadcasting#client-side-installation
 */
export const configureEcho = <T extends keyof Broadcaster>(
    config: EchoOptions<T>,
): void => {
    const defaults: ConfigDefaults<BroadcastDriver> = {
        reverb: {
            broadcaster: "reverb",
            key: import.meta.env.VITE_REVERB_APP_KEY,
            wsHost: import.meta.env.VITE_REVERB_HOST,
            wsPort: import.meta.env.VITE_REVERB_PORT,
            wssPort: import.meta.env.VITE_REVERB_PORT,
            forceTLS:
                (import.meta.env.VITE_REVERB_SCHEME ?? "https") === "https",
            enabledTransports: ["ws", "wss"],
        },
        pusher: {
            broadcaster: "pusher",
            key: import.meta.env.VITE_PUSHER_APP_KEY,
            cluster: import.meta.env.VITE_PUSHER_APP_CLUSTER,
            forceTLS: true,
            wsHost: import.meta.env.VITE_PUSHER_HOST,
            wsPort: import.meta.env.VITE_PUSHER_PORT,
            wssPort: import.meta.env.VITE_PUSHER_PORT,
            enabledTransports: ["ws", "wss"],
        },
        "socket.io": {
            broadcaster: "socket.io",
            host: import.meta.env.VITE_SOCKET_IO_HOST,
        },
        mercure: {
            broadcaster: "mercure",
            host: import.meta.env.VITE_MERCURE_HUB_URL,
        },
        null: {
            broadcaster: "null",
        },
        // fork (D-08): `ably` is the native Ably connector; authEndpoint defaults to /broadcasting/auth in the core
        ably: { broadcaster: "ably" },
    };

    // fork (provisional: P-02): without a broadcaster, the native Ably connector is used, as in the core.
    // Custom connector classes have no defaults to merge in...
    const broadcaster = config.broadcaster ?? "ably";

    echoConfig = {
        ...(typeof broadcaster === "string" ? defaults[broadcaster] : null),
        ...config,
        broadcaster,
    } as EchoConfig;

    // Reset the instance if it was already created
    if (echoInstance) {
        // fork (F-082): leave the old instance's channels, as the Svelte package does; the hooks then start
        // their channel registry over for the new instance
        echoInstance.leaveAllChannels();
        echoInstance = null;
    }
};

export const echo = <
    T extends keyof Broadcaster = BroadcastDriver,
>(): Echo<T> => getEchoInstance<T>();
