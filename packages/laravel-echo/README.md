# Laravel Echo for Ably (`@ably/laravel-echo`)

## Introduction

This package is Ably's fork of [Laravel Echo](https://github.com/laravel/echo). It is synced with upstream `laravel/echo` 2.x and keeps its public API, so the [Laravel broadcasting documentation](https://laravel.com/docs/broadcasting#client-side-installation) applies. It adds a native Ably connector, the `ably` broadcaster, built on Ably's [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) SDK.

For React, Vue and Svelte, use [`@ably/laravel-echo-react`](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/react/README.md), [`@ably/laravel-echo-vue`](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/vue/README.md) or [`@ably/laravel-echo-svelte`](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/svelte/README.md) together with this package.

> **Upgrading from 1.x?** See [UPDATING.md](https://github.com/ably-forks/laravel-echo/blob/2.x/UPDATING.md#1x--200).

## Requirements

- **Server:** [`ably/laravel-broadcaster`](https://github.com/ably/laravel-broadcaster) 2.0.0 or later. Echo 2.x works only with laravel-broadcaster 2.x, and the reverse, so upgrade both together. laravel-broadcaster 2.x supports PHP 8.1 or later and Laravel 8 to 13, the same range as 1.x.
    - Apps that stay on laravel-broadcaster 1.x stay on `@ably/laravel-echo` 1.1.x (see [Staying on 1.x](https://github.com/ably/laravel-broadcaster/blob/main/UPDATING.md#staying-on-1x)).
    - On PHP 7.2 to 8.0 or Laravel 6 or 7, use laravel-broadcaster 1.0.x with `@ably/laravel-echo` 1.0.x.
    - Laravel's built-in `ably` broadcaster is not supported: see [below](#not-supported-laravels-built-in-ably-broadcaster).
- **Node.js 22 or later** to install and build your app. This is the `engines` field of Echo and of `@ably/pubsub-device` v3. It affects build machines and CI, not browsers.
- **A bundler that understands ES2022 syntax**, for example Vite, webpack 5 with a current Babel or SWC, or esbuild.

## Installation

```bash
npm install @ably/laravel-echo
```

(`pnpm add @ably/laravel-echo` and `yarn add @ably/laravel-echo` work too.)

`@ably/pubsub-device` is a dependency of this package and is installed with it. You don't need to install `ably` or `@ably/pubsub-device` yourself, and Echo never reads a global `Ably`.

## Setup

Create the Echo instance in your application's JavaScript, for example in `resources/js/bootstrap.js` or `resources/js/echo.js`. If that file holds a Pusher or Reverb configuration, replace it with:

```js
import Echo from "@ably/laravel-echo";

window.Echo = new Echo({});
```

`broadcaster` is optional in this fork and defaults to `"ably"`, the native Ably connector (upstream requires it). `new Echo({ broadcaster: "ably" })` works the same.

Echo requests tokens from `/broadcasting/auth` by default. To use another URL, set `authEndpoint`; see [customizing the authorization endpoint](https://laravel.com/docs/broadcasting#customizing-the-authorization-endpoint):

```js
window.Echo = new Echo({
    authEndpoint: "/broadcasting/auth", // relative or absolute URL of your Laravel server
});
```

Every option that is not an Echo option is passed to Ably as a [client option](https://ably.com/docs/api/realtime-sdk#client-options), for example:

```js
window.Echo = new Echo({
    // Ably client options
    echoMessages: true, // Echo sets it to false itself; this overrides it
    queueMessages: true, // default: true
    disconnectedRetryTimeout: 15000, // retry after 15 s in the disconnected state
    suspendedRetryTimeout: 30000, // retry after 30 s in the suspended state
});
```

Don't use Ably's own auth options (`authUrl`, `authCallback`, `key`, …): Echo already gets its tokens from your Laravel server. The full list of Echo options is in [UPDATING.md](https://github.com/ably-forks/laravel-echo/blob/2.x/UPDATING.md#echo-options-in-200).

Then build your assets, for example with `npm run dev`.

**Login and logout without a page reload.** Echo switches to the new user, or to a guest, without a page reload. As part of logout, call `window.Echo.connect()` (then subscribe to your channels again) or `window.Echo.disconnect()`: otherwise the page keeps the old user's channel access until its token expires. See [UPDATING.md](https://github.com/ably-forks/laravel-echo/blob/2.x/UPDATING.md#login-user-switch-and-logout-in-the-same-page) for login, user switches, other open tabs and your own Ably client.

## Connection status

`connectionStatus()` returns the status of the connection as one of `"connected"`, `"connecting"`, `"reconnecting"`, `"disconnected"` or `"failed"`, as in upstream Echo:

```js
const status = window.Echo.connectionStatus();
```

The Ably connector maps Ably's [connection states](https://ably.com/docs/connect/states) to it:

| Ably connection state | `connectionStatus()`                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `initialized`         | `"connecting"`, or `"disconnected"` if `autoConnect` is `false`          |
| `connecting`          | `"connecting"`; `"reconnecting"` once this connection has been connected |
| `connected`           | `"connected"`                                                            |
| `disconnected`        | `"connecting"`; `"reconnecting"` once this connection has been connected |
| `suspended`           | `"disconnected"` (Ably keeps retrying, by default every 30 s)            |
| `closing`, `closed`   | `"disconnected"`                                                         |
| `failed`              | `"failed"`                                                               |

When the user changes (login, logout, user switch), Ably briefly reports `failed` (40102) while Echo reconnects with the new client ID. Echo reports that as `"reconnecting"` (or `"connecting"` before the first connection), for at most 1 s if the connection stays `failed`.

To be told about changes, use `onConnectionChange()`. It returns a function that unsubscribes. The callback is not called when you subscribe, only when the status (or, with Ably, the socket ID) changes:

```js
const unsubscribe = window.Echo.onConnectionChange((status) => {
    console.log(`Echo is ${status}`);
});

// later
unsubscribe();
```

`window.Echo.onConnectionChange()` is specific to this fork and is the recommended API. It works with every broadcaster and survives `window.Echo.connect()`: the callbacks move to the new connection and get its status once. Upstream's `window.Echo.connector.onConnectionChange()` also works, but stops at `window.Echo.connect()`, which replaces the connector.

For the raw Ably state, use the Ably client:

```js
console.log(window.Echo.connector.ably.connection.state);

window.Echo.connector.ably.connection.on((stateChange) => {
    if (stateChange.current === "connected") {
        console.log("connected to Ably");
    }
});
```

A catch-all Ably listener like this one runs before Echo updates its own status. If it reads `connectionStatus()` during the brief `failed` (40102) of a user switch, it sees `"failed"`. `onConnectionChange()` callbacks get the right status.

## Guest client IDs and the socket ID

laravel-broadcaster 2.x gives every guest a client ID (see [Guest client ids](https://github.com/ably/laravel-broadcaster/blob/main/UPDATING.md#guest-client-ids)), so every Ably connection has one.

`socketId()` returns the socket ID that Echo sends to your server as the `X-Socket-Id` header (with axios, jQuery, Vue Resource and Turbo). For Ably it encodes the connection key and the client ID, guests included. It is `undefined` until the connection is up, and no `X-Socket-Id` header is sent before that. `broadcast(...)->toOthers()` still excludes only the sending connection.

## Authorizing channels with your own request (Sanctum)

Laravel's [Sanctum documentation](https://laravel.com/docs/sanctum#authorizing-private-broadcast-channels) authorizes channels through an API route. With Ably, pass `requestTokenFn` instead of a custom `authorizer`:

```js
import axios from "axios";
import Echo from "@ably/laravel-echo";

window.Echo = new Echo({
    requestTokenFn: async (channelName, existingToken) => {
        const res = await axios.post("/api/broadcasting/auth", {
            channel_name: channelName,
            token: existingToken,
        });
        return res.data; // { token, info? }
    },
});
```

- `channelName` is `null` for the connection token, and `existingToken` is `null` until Echo has a token.
- The function must resolve with your server's token response, `{ token, info? }`.
- Don't wrap it in try/catch: Echo handles its errors. Each call is bounded to 30 s.

## Channel names on Ably

The Ably connector prefixes channel names with their visibility:

```js
const publicChannel = window.Echo.channel("channel1");
console.log(publicChannel.name); // public:channel1

const privateChannel = window.Echo.private("channel2");
console.log(privateChannel.name); // private:channel2

const presenceChannel = window.Echo.join("channel3");
console.log(presenceChannel.name); // presence:channel3
```

- Use these names to [watch the channels in Ably's dev console](https://ably.com/docs/tools).
- Use them to leave a channel: `window.Echo.leaveChannel(privateChannel.name)`.
- Or pass the visibility instead (specific to this fork): `window.Echo.leaveChannel("channel2", "private")`.
- To get the connector's full channel name for a name and a visibility (specific to this fork), use `window.Echo.connectorChannelName("channel2", "private")`. It returns `private:channel2` with the Ably connector, and `private-channel2` with the other connectors (a public channel keeps its bare name there).

## Whisper acknowledgements

`whisper()` on a private or presence channel takes an optional callback, called with `null` on success or with the error:

```js
privateChannel.subscribed(() => {
    privateChannel.whisper("typing", { name: "Jonny" }, (err) => {
        if (err) {
            console.log("whisper failed with error " + err);
        } else {
            console.log("whisper succeeded");
        }
    });
});
```

## Script tag (IIFE)

Without a bundler, load the IIFE build. It includes `@ably/pubsub-device`, so no other Ably script is needed:

```html
<script src="https://cdn.jsdelivr.net/npm/@ably/laravel-echo@2/dist/echo.iife.js"></script>
<script>
    window.Echo = new Echo({});
</script>
```

The global `Echo` is the Echo class, as in 1.x. Upstream's form `new Echo.default({})` also works, and `Echo.Channel`, `Echo.Connector` and `Echo.EventFormatter` are there too. The file is also exported as `@ably/laravel-echo/iife`.

## Other broadcasters

This package keeps upstream's `reverb`, `pusher`, `socket.io`, `mercure` and `null` broadcasters, unchanged. As upstream, it does not include their client libraries:

- **Pusher and Reverb:** install `pusher-js` and pass it as `Pusher` in the options, or set `window.Pusher`.
- **Socket.IO:** install `socket.io-client` and pass its `io` function as `client` in the options, or set `window.io`.

## Upstream's `ably` broadcaster

In upstream `laravel-echo`, `broadcaster: "ably"` is a Pusher-protocol connection to Ably's Pusher adapter. In this package, `ably` is the native Ably connector, which needs `ably/laravel-broadcaster` on the server. To keep upstream's behaviour, use upstream `laravel-echo` with `broadcaster: "pusher"` and `wsHost: "realtime-pusher.ably.io"`.

## Not supported: Laravel's built-in `ably` broadcaster

`@ably/laravel-echo` needs [`ably/laravel-broadcaster`](https://github.com/ably/laravel-broadcaster) 2.x on the server. Laravel also ships a built-in `ably` broadcast driver (`AblyBroadcaster`, and `Ably2Broadcaster` on Laravel 13). It speaks the Pusher protocol: it returns `{"auth": "key:signature"}` instead of an Ably token, and refuses requests without a channel name. It does not work with this package.

- If you use the built-in driver, use upstream `laravel-echo` with `pusher-js`, `broadcaster: "pusher"` and `wsHost: "realtime-pusher.ably.io"`.
- To use this package, install `ably/laravel-broadcaster` 2.x. It replaces the built-in driver for every connection with `'driver' => 'ably'`. See [Laravel's built-in `ably` driver](https://github.com/ably/laravel-broadcaster/blob/main/UPDATING.md#laravel-built-in-ably-driver) in its UPDATING.md.

## Troubleshooting

Echo logs the hints below to the browser console: the auth endpoint hints once per page, the 40161 hint once per connector.

### The connection token request gets a 403

The hint starts with `@ably/laravel-echo: the auth endpoint refused the connection token request (HTTP 403).` The connection token request has no channel name, and laravel-broadcaster 2.x gives guests a token too, so a 403 there has one of these causes:

1. **Laravel's built-in `ably` broadcaster handles the request** (the most likely cause). It refuses every request without a channel name. Install `ably/laravel-broadcaster` 2.x and check that it is active (below).
2. **A middleware on the broadcasting auth route denied the request.**
3. **The token that Echo presented could not be re-signed**, for example a malformed token or one from another app. This is rare.

A stale CSRF token gives a 419, not a 403: refresh the CSRF token, then call `window.Echo.connect()` (see [CSRF tokens and 419 errors](https://github.com/ably-forks/laravel-echo/blob/2.x/UPDATING.md#csrf-tokens-and-419-errors)).

**The built-in driver can be active although `ably/laravel-broadcaster` is installed** when the package's service provider is not registered, or registered too late:

- **The package is in `dont-discover`:** remove `ably/laravel-broadcaster` (or `*`) from `extra.laravel.dont-discover` in your `composer.json`.
- **`bootstrap/cache/packages.php` is stale**, for example after `composer install --no-scripts`: run `php artisan package:discover`.
- **The broadcaster was resolved before the package's provider booted**, for example by another package's service provider: define your channels in `routes/channels.php` or in your app's own service providers, which run after package providers.

On Laravel 13.41.0 and later this fails silently on the server: Laravel falls back to its built-in Pusher-protocol driver, and Echo's connection token request gets the 403 above. To check which driver is active, run `get_class(Broadcast::connection('ably'))` in `php artisan tinker`: it must return `Ably\LaravelBroadcaster\AblyBroadcaster`.

### The auth endpoint returned a Pusher-protocol response

The hint starts with `@ably/laravel-echo: the auth endpoint returned a Pusher-protocol response`. Your auth endpoint answered with `{"auth": "key:signature"}`, the response of Laravel's built-in `ably` broadcaster, instead of an Ably token. Install `ably/laravel-broadcaster` 2.x and check that it is active, as described above.

### 40161 on MAU-billed Ably accounts

On an Ably account billed by monthly active users (MAU), every connection needs a client ID. laravel-broadcaster 2.x always issues one, also to guests. If a connection still has none, it fails with 40161 and Echo logs:

> Your Ably account requires an identified client on every connection (MAU billing), but this connection has no clientId. Use laravel-broadcaster v2, which always issues guest client ids, or make sure your auth endpoint returns a token with a clientId.

This happens when the token does not come from laravel-broadcaster 2.x, for example from your own `requestTokenFn` endpoint.

## Further documentation

- [Laravel broadcasting](https://laravel.com/docs/broadcasting)
- [Ably documentation](https://ably.com/docs)
- [UPDATING.md](https://github.com/ably-forks/laravel-echo/blob/2.x/UPDATING.md) and [CHANGELOG-ABLY.md](https://github.com/ably-forks/laravel-echo/blob/2.x/CHANGELOG-ABLY.md)
- [Contributing](https://github.com/ably-forks/laravel-echo/blob/2.x/CONTRIBUTING.md)
