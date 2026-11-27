# Laravel Echo Vue Helpers for Ably (`@ably/laravel-echo-vue`)

Vue composables for [`@ably/laravel-echo`](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/laravel-echo/README.md), Ably's fork of Laravel Echo. This package is Ably's port of upstream Laravel Echo's Vue package (2.x), with the same composables, and uses Echo's native Ably connector by default. On the server, use [`ably/laravel-broadcaster`](https://github.com/ably/laravel-broadcaster) 2.x.

## Installation

Install this package together with `@ably/laravel-echo`, which is a peer dependency:

```bash
npm install @ably/laravel-echo @ably/laravel-echo-vue
```

(`pnpm add @ably/laravel-echo @ably/laravel-echo-vue` and `yarn add @ably/laravel-echo @ably/laravel-echo-vue` work too.)

It needs Vue 3, and Node.js 22 or later to install and build.

## `configureEcho`

You must call this function somewhere in your app _before_ you use `useEcho` in a component to configure your Echo instance. With Ably, you don't need to pass anything:

```ts
import { configureEcho } from "@ably/laravel-echo-vue";

configureEcho({});
```

Without a `broadcaster`, the package uses `@ably/laravel-echo`'s native Ably connector, which gets its tokens from `/broadcasting/auth`. You can pass any [`@ably/laravel-echo` option](https://github.com/ably-forks/laravel-echo/blob/2.x/UPDATING.md#echo-options-in-200), such as `authEndpoint` or an Ably client option. `configureEcho({ broadcaster: "ably" })` works the same.

For the other broadcasters, the package will fill in appropriate defaults for the rest of the config [based on the Echo documentation](https://laravel.com/docs/broadcasting#client-side-installation). You can always override these values by simply passing in your own. Unlike upstream, this package does not include `pusher-js`: for `reverb` and `pusher`, install it and pass it as `Pusher` (or set `window.Pusher`):

```ts
import Pusher from "pusher-js";
import { configureEcho } from "@ably/laravel-echo-vue";

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
import { configureEcho } from "@ably/laravel-echo-vue";
import { WaveConnector } from "laravel-wave";

configureEcho({
    broadcaster: WaveConnector,
});
```

## Composables

| Composable                                                                                     | Use it to                                                         |
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

The composables take the channel name your app uses, as with any broadcaster: `useEcho("orders.1", …)` listens on the private channel `orders.1`. The Ably connector names it `private:orders.1` on Ably (`public:` and `presence:` for the other visibilities); use that name in [Ably's dev console](https://ably.com/docs/tools). When a composable leaves a channel (`leaveChannel()`, or when the last component that uses it unmounts), it leaves only the channel of its own visibility; `leave()` also leaves the private and presence channels of that name.

## Connection Status

You can get the current WebSocket connection status using the `useConnectionStatus` composable or the `echo().connectionStatus()` utility function.

### `useConnectionStatus` Composable (Reactive)

The `useConnectionStatus` composable provides **reactive** connection status that automatically updates when the connection state changes. Use this in Vue components that need to display live connection status:

```vue
<script setup>
import { useConnectionStatus } from "@ably/laravel-echo-vue";

const status = useConnectionStatus(); // Automatically updates when status changes

const getStatusColor = (status) => {
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
</script>

<template>
    <div :style="{ color: getStatusColor(status) }">
        Connection: {{ status }}
    </div>
</template>
```

### Status Values

- `"connected"` - Successfully connected to the WebSocket server
- `"disconnected"` - Not connected and not attempting to reconnect
- `"connecting"` - Initial connection attempt in progress
- `"reconnecting"` - Attempting to reconnect after a disconnection
- `"failed"` - Connection failed and won't retry

With Ably, the status comes from Ably's connection state, mapped as in [`@ably/laravel-echo`'s connection status table](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/laravel-echo/README.md#connection-status). For example, Ably's `suspended` state is reported as `"disconnected"`, although Ably keeps retrying.

`useConnectionStatus` and `useSocketId` subscribe through `echo().onConnectionChange()` when the component mounts, so they keep working after `echo().connect()`. As upstream, they use the Echo instance of the component's setup, also if you call `configureEcho()` again later.

### `useSocketId`

`useSocketId` returns a ref to the socket ID that Echo sends as the `X-Socket-Id` header. It is `undefined` until the connection is up, and updates when it changes:

```vue
<script setup>
import { useSocketId } from "@ably/laravel-echo-vue";

const socketId = useSocketId();
</script>

<template>
    <span>{{ socketId ?? "not connected" }}</span>
</template>
```

## `useEcho` Composable

Connect to private channel:

```ts
import { useEcho } from "@ably/laravel-echo-vue";

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

Without a bundler, load the scripts in this order: the `@ably/laravel-echo` IIFE first (it provides the global `Echo`), then Vue (the global `Vue`), then this package's IIFE (it provides the global `EchoVue`):

```html
<script src="https://cdn.jsdelivr.net/npm/@ably/laravel-echo@2/dist/echo.iife.js"></script>
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ably/laravel-echo-vue@2/dist/echo-vue.iife.js"></script>
<script>
    EchoVue.configureEcho({});
</script>
```

The file is also exported as `@ably/laravel-echo-vue/iife`. It does not include `@ably/laravel-echo`, which it reads from the global `Echo`.

## Server-side rendering (Nuxt and others)

During server-side rendering (when the app is rendered with Vue's SSR context, as in Nuxt), the composables create no Echo instance and subscribe to nothing: `useConnectionStatus` returns `"disconnected"`, `useSocketId` returns `undefined`, and the channel of `useEcho` and `useChannel` is `null`. In the browser they behave as upstream: they subscribe when the component's setup runs. `configureEcho()` only stores the configuration, so it is safe on the server; don't call `echo()` there yourself, because that opens an Ably connection from the server.

## Not included

- The Laravel Boost skills in `resources/boost` are not shipped with the Ably packages.
