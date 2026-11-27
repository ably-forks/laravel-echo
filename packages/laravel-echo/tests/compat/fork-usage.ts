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
// encrypted private channels do not exist with the Ably broadcaster: typed `never` (it throws; this file never runs)
const encrypted: never = echo.encryptedPrivate("secret");
new EventFormatter("App.Events").format("OrderShipped");

void [
    sameConnector,
    state,
    privateChannel,
    asUpstreamChannel,
    asUpstreamPresence,
    asUpstreamConnector,
    fullName,
    status,
    encrypted,
];
