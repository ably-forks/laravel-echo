/**
 * The fork's additions, type-checked from the package's root entry as consumers import it
 * (`@ably/laravel-echo-react`, resolved through package.json `exports` to dist/index.d.ts). Unlike
 * upstream-usage.ts, this file is fork-only: `broadcaster` may be omitted (the native Ably connector, P-02), the
 * Ably options of the core are accepted, and echo() exposes the core's Echo.onConnectionChange (P-03) and
 * visibility-aware leaveChannel (P-04).
 */
/* oxlint-disable no-console -- the README's usage logs the payloads */
import {
    configureEcho,
    echo,
    useConnectionStatus,
    type ConnectionStatus,
} from "@ably/laravel-echo-react";

configureEcho({});
configureEcho({ authEndpoint: "/broadcasting/auth" });
configureEcho({
    broadcaster: "ably",
    authEndpoint: "/broadcasting/auth",
    autoConnect: false,
    requestTokenFn: async (channelName: string | null) => ({
        token: channelName ?? "connection",
    }),
});

const unsubscribe: () => void = echo().onConnectionChange(
    (status: ConnectionStatus) => console.log(status),
);
unsubscribe();
echo().leaveChannel("orders", "private");
const fullName: string = echo().connectorChannelName("orders", "presence");
const ablyEcho = echo<"ably">();
ablyEcho.private("orders").listen(".OrderShipped", () => {});
function StatusText(): string {
    const current: ConnectionStatus = useConnectionStatus();

    return current;
}

void [fullName, StatusText];
