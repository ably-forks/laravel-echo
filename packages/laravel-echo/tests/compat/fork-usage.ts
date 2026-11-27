/**
 * The fork's additions, type-checked from the package's root entry as consumers import it (`@ably/laravel-echo`,
 * resolved through package.json `exports` to dist/echo.d.ts). Unlike upstream-usage.ts, this file is fork-only:
 * the `ably` broadcaster is the native Ably connector (D-08), and AblyOptions, ChannelVisibility and the
 * visibility-aware leaveChannel() are additive (UC-05, P-04). The Ably classes are reached through `Broadcaster`,
 * as upstream exposes its own connector and channel types; there is no deep import.
 */
import Echo, {
    Channel,
    Connector,
    EventFormatter,
    type AblyOptions,
    type Broadcaster,
    type ChannelVisibility,
    type ConnectionStatus,
    type EchoOptions,
    type PresenceChannel,
} from "@ably/laravel-echo";

type AblyConnector = Broadcaster["ably"]["connector"];
type AblyChannel = Broadcaster["ably"]["public"];
type AblyPrivateChannel = Broadcaster["ably"]["private"];
type AblyPresenceChannel = Broadcaster["ably"]["presence"];

const requestTokenFn: AblyOptions["requestTokenFn"] = async (
    channelName,
    existingToken,
) => ({
    token: `${channelName ?? "connection"}:${existingToken ?? ""}`,
});
const ablyOptions: EchoOptions<"ably"> = {
    broadcaster: "ably",
    authEndpoint: "/broadcasting/auth",
    requestTokenFn,
    endpoint: "nonprod:sandbox",
    autoConnect: false,
};
const echo = new Echo<"ably">(ablyOptions);
const inferred = new Echo({
    broadcaster: "ably",
    requestTokenFn,
    autoConnect: false,
});

// broadcaster is optional and defaults to "ably" (fork-only, P-02): inferred as Echo<"ably">, with the Ably connector
type Equals<A, B> =
    (<V>() => V extends A ? 1 : 2) extends <V>() => V extends B ? 1 : 2
        ? true
        : false;
const byDefault = new Echo({
    authEndpoint: "/broadcasting/auth",
    requestTokenFn,
    autoConnect: false,
});
const inferredAsAbly: Equals<typeof byDefault, Echo<"ably">> = true;
const defaultTypeArgument: Equals<Echo, Echo<"ably">> = true;
const defaultConnector: AblyConnector = byDefault.connector;
const optionsWithoutBroadcaster: EchoOptions<"ably"> = {
    authEndpoint: "/broadcasting/auth",
};
const fromOptions: Echo<"ably"> = new Echo(optionsWithoutBroadcaster);

const connector: AblyConnector = echo.connector;
const sameConnector: AblyConnector = inferred.connector;
const state: string = connector.ably.connection.state;
const publicChannel: AblyChannel = echo
    .channel("orders")
    .listen("OrderShipped", () => {});
const privateChannel: AblyPrivateChannel = echo
    .private("chat")
    .whisper("typing", { a: 1 });
const presenceChannel: AblyPresenceChannel = echo
    .join("room")
    .here(() => {})
    .joining(() => {})
    .leaving(() => {});
const asUpstreamChannel: Channel = publicChannel;
const asUpstreamPresence: PresenceChannel = presenceChannel;
const asUpstreamConnector: Connector<
    "ably",
    AblyChannel,
    AblyPrivateChannel,
    AblyPresenceChannel
> = connector;

const visibilities: ChannelVisibility[] = ["public", "private", "presence"];
visibilities.forEach((visibility) => echo.leaveChannel("orders", visibility));
echo.leaveChannel("private:chat");
const fullName: string = echo.connectorChannelName("chat", "private");
const status: ConnectionStatus = echo.connectionStatus();
// Echo.onConnectionChange (fork-only, P-03): survives Echo.connect(); returns the unsubscribe function
const unsubscribe: () => void = echo.onConnectionChange(
    (next: ConnectionStatus) => void next,
);
unsubscribe();
const offConnector: () => void = connector.onConnectionChange(() => {});
const socketId: string | undefined = echo.socketId();
const connectorSocketId: string | undefined = connector.socketId();
// encrypted private channels do not exist with the Ably broadcaster: typed `never` (it throws; this file never runs)
const encrypted: never = echo.encryptedPrivate("secret");
new EventFormatter("App.Events").format("OrderShipped");

void [
    inferredAsAbly,
    defaultTypeArgument,
    defaultConnector,
    fromOptions,
    sameConnector,
    state,
    privateChannel,
    asUpstreamChannel,
    asUpstreamPresence,
    asUpstreamConnector,
    fullName,
    status,
    offConnector,
    socketId,
    connectorSocketId,
    encrypted,
];
