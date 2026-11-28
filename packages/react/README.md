# Laravel Echo React Helpers for Ably (`@ably/laravel-echo-react`)

React hooks for [`@ably/laravel-echo`](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/laravel-echo/README.md), Ably's fork of Laravel Echo. This package is Ably's port of upstream Laravel Echo's React package (2.x), with the same hooks, and uses Echo's native Ably connector by default. On the server, use [`ably/laravel-broadcaster`](https://github.com/ably/laravel-broadcaster) 2.x.

## Installation

Install this package together with `@ably/laravel-echo`, which is a peer dependency:

```bash
npm install @ably/laravel-echo @ably/laravel-echo-react
```

(`pnpm add @ably/laravel-echo @ably/laravel-echo-react` and `yarn add @ably/laravel-echo @ably/laravel-echo-react` work too.)

It needs React 16.8 or later, and Node.js 22 or later to install and build.

## `configureEcho`

You must call this function somewhere in your app _before_ you use `useEcho` in a component to configure your Echo instance. With Ably, you don't need to pass anything:

```ts
import { configureEcho } from "@ably/laravel-echo-react";

configureEcho({});
```

Without a `broadcaster`, the package uses `@ably/laravel-echo`'s native Ably connector, which gets its tokens from `/broadcasting/auth`. You can pass any [`@ably/laravel-echo` option](https://github.com/ably-forks/laravel-echo/blob/2.x/UPDATING.md#echo-options-in-200), such as `authEndpoint` or an Ably client option. `configureEcho({ broadcaster: "ably" })` works the same.

For the other broadcasters, the package will fill in appropriate defaults for the rest of the config [based on the Echo documentation](https://laravel.com/docs/broadcasting#client-side-installation). You can always override these values by simply passing in your own. Unlike upstream, this package does not include `pusher-js`: for `reverb` and `pusher`, install it and pass it as `Pusher` (or set `window.Pusher`):

```ts
import Pusher from "pusher-js";
import { configureEcho } from "@ably/laravel-echo-react";

configureEcho({
    broadcaster: "reverb",
    Pusher,
});
```

In the above example, the configuration would also fill in the following keys if they aren't present:

```ts
{
    key: import.meta.env.VITE_REVERB_APP_KEY,
    wsHost: import.meta.env.VITE_REVERB_HOST,
    wsPort: import.meta.env.VITE_REVERB_PORT,
    wssPort: import.meta.env.VITE_REVERB_PORT,
    forceTLS: (import.meta.env.VITE_REVERB_SCHEME ?? 'https') === 'https',
    enabledTransports: ['ws', 'wss'],
}
```

For `socket.io`, pass the `io` function of `socket.io-client` as `client`, or set `window.io`, as upstream.

You may also pass a custom connector class instead of a built-in driver name. No defaults are merged in for custom connectors, so pass everything the connector needs:

```ts
import { configureEcho } from "@ably/laravel-echo-react";
import { WaveConnector } from "laravel-wave";

configureEcho({
    broadcaster: WaveConnector,
});
```

## Hooks

| Hook                                                                                           | Use it to                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `useEcho(channel, event, callback, dependencies?, visibility?)`                                | Listen for events on a private channel (or the given visibility). |
| `useEchoPublic(channel, event, callback, dependencies?)`                                       | Listen for events on a public channel.                            |
| `useEchoPresence(channel, event, callback, dependencies?)`                                     | Listen for events on a presence channel.                          |
| `useEchoNotification(channel, callback, event?, dependencies?)`                                | Listen for Laravel notifications on a private channel.            |
| `useEchoModel(model, id, events, callback, dependencies?)`                                     | Listen for model broadcast events.                                |
| `useChannel(channel, visibility?)`, `usePublicChannel(channel)`, `usePresenceChannel(channel)` | Get a channel without listening for events.                       |
| `useConnectionStatus()`                                                                        | Get the connection status, updated on every change.               |
| `useSocketId()`                                                                                | Get the socket ID, `undefined` until the connection is up.        |

`echo()` returns the Echo instance and `echoIsConfigured()` tells whether `configureEcho()` was called.

## Channel names on Ably

The hooks take the channel name your app uses, as with any broadcaster: `useEcho("orders.1", …)` listens on the private channel `orders.1`. The Ably connector names it `private:orders.1` on Ably (`public:` and `presence:` for the other visibilities); use that name in [Ably's dev console](https://ably.com/docs/tools). When a hook leaves a channel (`leaveChannel()`, or when the last component that uses it unmounts), it leaves only the channel of its own visibility; `leave()` also leaves the private and presence channels of that name.

## Connection Status

You can get the current WebSocket connection status using the `useConnectionStatus` hook or the `echo().connectionStatus()` utility function.

### `useConnectionStatus` Hook (Reactive)

The `useConnectionStatus` hook provides **reactive** connection status that automatically updates when the connection state changes. Use this in React components that need to display live connection status:

```ts
import { useConnectionStatus } from "@ably/laravel-echo-react";

function ConnectionIndicator() {
    const status = useConnectionStatus(); // Automatically updates when status changes

    const getStatusColor = (status: string) => {
        switch (status) {
            case "connected":
                return "green";
            case "connecting":
                return "yellow";
            case "reconnecting":
                return "orange";
            case "failed":
                return "red";
            default:
                return "gray";
        }
    };

    return (
        <div style={{ color: getStatusColor(status) }}>
            Connection: {status}
        </div>
    );
}
```

### Status Values

- `"connected"` - Successfully connected to the WebSocket server
- `"disconnected"` - Not connected and not attempting to reconnect
- `"connecting"` - Initial connection attempt in progress
- `"reconnecting"` - Attempting to reconnect after a disconnection
- `"failed"` - Connection failed and won't retry

With Ably, the status comes from Ably's connection state, mapped as in [`@ably/laravel-echo`'s connection status table](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/laravel-echo/README.md#connection-status). For example, Ably's `suspended` state is reported as `"disconnected"`, although Ably keeps retrying.

`useConnectionStatus` and `useSocketId` subscribe through `echo().onConnectionChange()`, so they keep working after `echo().connect()`. As upstream, they stay on the Echo instance they started with if you call `configureEcho()` again.

### `useSocketId`

`useSocketId` returns the socket ID that Echo sends as the `X-Socket-Id` header. It is `undefined` until the connection is up, and updates when it changes:

```ts
import { useSocketId } from "@ably/laravel-echo-react";

function SocketId() {
    const socketId = useSocketId();

    return <span>{socketId ?? "not connected"}</span>;
}
```

## `useEcho` Hook

Connect to private channel:

```ts
import { useEcho } from "@ably/laravel-echo-react";

const { leaveChannel, leave, stopListening, listen } = useEcho(
    `orders.${orderId}`,
    "OrderShipmentStatusUpdated",
    (e) => {
        console.log(e.order);
    },
);

// Stop listening without leaving channel
stopListening();

// Start listening again
listen();

// Leave channel
leaveChannel();

// Leave a channel and also its associated private and presence channels
leave();
```

Multiple events:

```ts
useEcho(
    `orders.${orderId}`,
    ["OrderShipmentStatusUpdated", "OrderShipped"],
    (e) => {
        console.log(e.order);
    },
);
```

Specify shape of payload data:

```ts
type OrderData = {
    order: {
        id: number;
        user: {
            id: number;
            name: string;
        };
        created_at: string;
    };
};

useEcho<OrderData>(`orders.${orderId}`, "OrderShipmentStatusUpdated", (e) => {
    console.log(e.order.id);
    console.log(e.order.user.id);
});
```

Connect to public channel:

```ts
useEchoPublic("posts", "PostPublished", (e) => {
    console.log(e.post);
});
```

Connect to presence channel:

```ts
useEchoPresence("posts", "PostPublished", (e) => {
    console.log(e.post);
});
```

Listening for model events:

```ts
useEchoModel("App.Models.User", userId, ["UserCreated", "UserUpdated"], (e) => {
    console.log(e.model);
});
```

## Script tag (IIFE)

Without a bundler, load the scripts in this order: the `@ably/laravel-echo` IIFE first (it provides the global `Echo`), then React (the global `React`), then this package's IIFE (it provides the global `EchoReact`):

```html
<script src="https://cdn.jsdelivr.net/npm/@ably/laravel-echo@2/dist/echo.iife.js"></script>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ably/laravel-echo-react@2/dist/echo-react.iife.js"></script>
<script>
    EchoReact.configureEcho({});
</script>
```

The file is also exported as `@ably/laravel-echo-react/iife`. It does not include `@ably/laravel-echo`, which it reads from the global `Echo`.

## Not included

- The Laravel Boost skills in `resources/boost` are not shipped with the Ably packages.
