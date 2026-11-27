# Upgrade / Migration Guide

<a id="1x--200"></a>

## 1.x → 2.0.0

`@ably/laravel-echo` 2.0.0 is a major release. It is synced with upstream `laravel/echo` 2.x (v2.6.3 and later), keeps upstream's public API, and adds React, Vue and Svelte packages: `@ably/laravel-echo-react`, `@ably/laravel-echo-vue` and `@ably/laravel-echo-svelte`. It works only with [laravel-broadcaster](https://github.com/ably/laravel-broadcaster) 2.0.0 or later, which always gives guests a client ID.

Most apps that use the `ably` broadcaster change only the install line. The Echo API, the `ably` channel names (`public:`, `private:`, `presence:`) and the auth endpoint contract are unchanged.

### Upgrade order

1. **Upgrade both packages together.** Upgrade laravel-broadcaster to 2.0.0 and `@ably/laravel-echo` to 2.0.0, and deploy them in the same release. Mixed versions (Echo 2.x with laravel-broadcaster 1.x, or the reverse) are not supported.
    - Apps that stay on laravel-broadcaster 1.x stay on `@ably/laravel-echo` 1.1.x (see [Staying on 1.x](https://github.com/ably/laravel-broadcaster/blob/main/UPDATING.md#staying-on-1x)). laravel-broadcaster 2.x keeps the PHP 8.1 or later and Laravel 8 to 13 range of 1.x.
    - On PHP 7.2 to 8.0 or Laravel 6 or 7, use laravel-broadcaster 1.0.x with `@ably/laravel-echo` 1.0.x.
2. **Client:** run `npm install @ably/laravel-echo@^2` (or `pnpm add`, `yarn add`), and rebuild your assets.
3. **Server:** run `composer require ably/laravel-broadcaster:^2.0`. Remove the MAU option from your server config: the `mau_account` line in `config/broadcasting.php` and its `.env` variable. laravel-broadcaster 2.x always issues guest client IDs and ignores the option. See [laravel-broadcaster's upgrade guide](https://github.com/ably/laravel-broadcaster/blob/main/UPDATING.md#11--20).
4. **Check the breaking changes below**, in particular if you use TypeScript, a custom connector, the socket ID, or a broadcaster other than `ably`.

### Breaking changes

| # | Change | What to do |
| --- | --- | --- |
| 1 | Echo 2.0.0 works only with laravel-broadcaster 2.0.0 or later, and the reverse. | Upgrade both together (see [Upgrade order](#upgrade-order)). |
| 2 | A custom `broadcaster` must be a class (a constructor). A factory function now throws `Broadcaster function … is not supported.` | Pass your connector class, as upstream Echo 2.x requires. |
| 3 | TypeScript: `Echo` is generic, `Echo<T = "ably">`, with typed options per broadcaster; `Connector` is generic; channel callbacks are `CallableFunction` and channel methods return `this`; `socketId()` returns `string \| undefined`; `whisper(event, data)` takes an object (`Record<any, any>`). New exported types: `Broadcaster`, `BroadcastDriver`, `EchoOptions`, `AblyOptions`, `ConnectionStatus` and `ChannelVisibility`. | Fix the type errors your compiler reports, for example pass an object to `whisper()`. See [TypeScript](#typescript). |
| 4 | Packaging: the package is `"type": "module"` with an `exports` map, so deep imports such as `@ably/laravel-echo/dist/...` no longer resolve. Types are at `dist/echo.d.ts`; `typings/` is no longer shipped. The CommonJS build is `dist/echo.common.cjs`, and `require("@ably/laravel-echo")` works. The IIFE build is `dist/echo.iife.js`, also exported as `@ably/laravel-echo/iife`. The React, Vue and Svelte packages follow the same pattern: Vue and Svelte use `dist/index.common.cjs`; React uses `dist/index.common.cjs` for `require`, and `dist/index.common.js` for `main` and the `react-native` condition. The build target is ES2022. | Import from the package root (or `@ably/laravel-echo/iife`). Use a bundler that understands ES2022 syntax, for example Vite, webpack 5 with a current Babel or SWC, or esbuild, and Node.js 22 or later to install and build. |
| 5 | Node.js 22 or later is required to install and build, as in 1.1. Working on this repository needs Node.js 22.18, 24.11 or 26 or later, and pnpm 12 (see [CONTRIBUTING.md](CONTRIBUTING.md)). | Nothing, if you already use Node.js 22. |
| 6 | `pusher-js` and `socket.io-client` are optional peer dependencies of `@ably/laravel-echo`, as upstream. The React, Vue and Svelte packages don't import or inject `Pusher` (upstream's do). | With `pusher` or `reverb`: install `pusher-js` and pass it as `Pusher` in the options, or set `window.Pusher`. With `socket.io`: pass the `io` function of `socket.io-client` as `client`, or set `window.io` (as upstream). See [Other broadcasters](#pusher-reverb-and-socketio). |
| 7 | `broadcaster` is optional and defaults to `"ably"` (specific to this fork; upstream requires it). `encryptedPrivate()` throws for broadcasters that don't support encrypted channels; with `ably` it throws `Encrypted private channels are not supported with the Ably broadcaster`, as in 1.x. | Nothing: 1.x configs with `broadcaster: "ably"` keep working, and you may drop the option. |
| 8 | Custom connector classes must implement `connectionStatus()` and `onConnectionChange()`, as upstream's `Connector` requires. | Add both methods to your connector. |
| 9 | `ably` means the native Ably connector. In upstream `laravel-echo`, `ably` is a Pusher-protocol connection to Ably's Pusher adapter. | If you used upstream's `ably`, stay on upstream `laravel-echo` with `broadcaster: "pusher"` and `wsHost: "realtime-pusher.ably.io"`. |
| 10 | New packages `@ably/laravel-echo-react`, `@ably/laravel-echo-vue` and `@ably/laravel-echo-svelte`, ports of upstream's `@laravel/echo-react`, `-vue` and `-svelte`. They have a peer dependency on `@ably/laravel-echo` and don't bundle it or `@ably/pubsub-device`. Their hooks leave a channel by its name and visibility. | Replace `@laravel/echo-react` (or `-vue`, `-svelte`) with the Ably package, and install `@ably/laravel-echo` next to it. See their READMEs. |
| 11 | Every connection has a client ID: laravel-broadcaster 2.x gives every guest one. The socket ID, and so the `X-Socket-Id` header, carries a guest's client ID too. `toOthers()` still excludes only the sending connection. | Change code that tested for a `null` guest client ID or socket ID. |
| 12 | The repository is a pnpm monorepo built with Vite+, tested with Vitest and checked with oxlint and oxfmt. | Contributors only: see [CONTRIBUTING.md](CONTRIBUTING.md). |
| 13 | `socketId()` returns `undefined` until the connection is up (1.x returned `''`), and no `X-Socket-Id` header is sent before that, by any of the axios, jQuery, Vue Resource and Turbo interceptors. | Test the socket ID for a falsy value, not for `''`. See [Socket ID](#socket-id-before-the-connection-is-up). |
| 14 | New: `connectionStatus()`, `onConnectionChange()` (specific to this fork) and, in the framework packages, `useConnectionStatus` and `useSocketId`. | Optional. See [Connection status](#connection-status). |
| 15 | Security fix: with the `ably` broadcaster, Echo copies `auth.headers` for each connector. A bearer token or CSRF header no longer leaks to another Echo instance, for example the previous user's bearer token after a logout and a new Echo instance, and Echo no longer changes your options object. | Nothing. |
| 16 | Laravel's built-in `ably` broadcaster is not supported. | Use laravel-broadcaster 2.x on the server. See ["Not supported: Laravel's built-in `ably` broadcaster"](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/laravel-echo/README.md#not-supported-laravels-built-in-ably-broadcaster) in the README. |

<a id="echo-options-in-200"></a>

### Echo options in 2.0.0

Echo's own options with the `ably` broadcaster. Every other option is passed to Ably as a [client option](https://ably.com/docs/api/realtime-sdk#client-options) (for example `echoMessages`, `queueMessages`, `disconnectedRetryTimeout`, `suspendedRetryTimeout`, `tls`). Echo sets `echoMessages: false` itself, and an `echoMessages` you pass overrides it. Ably's own auth options (`authUrl`, `authCallback`, `key`, …) should not be used, because Echo gets its tokens from your Laravel server.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `broadcaster` | `"ably"` or another driver name or class | `"ably"` | Optional (specific to this fork). |
| `authEndpoint` | `string` | `"/broadcasting/auth"` | Relative URLs resolve against the page URL. |
| `auth.headers` | `Record<string, string>` | `{}` | Extra headers for token requests. |
| `csrfToken` | `string \| null` | `null` | Read in this order: `window.Laravel.csrfToken`, this option, the `<meta name="csrf-token">` tag. Sent as `X-CSRF-TOKEN`. |
| `bearerToken` | `string \| null` | `null` | Sent as `Authorization: Bearer …`. |
| `namespace` | `string \| false` | `"App.Events"` | Prefix of event names; `false` for none. |
| `requestTokenFn` | `(channelName: string \| null, existingToken: string \| null) => Promise<{ token: string; info?: unknown }>` | none | Replaces the request to `authEndpoint`. See [`requestTokenFn`](#requesttokenfn). |
| `client` | `PubSubClient` | none | Your own Ably client, used as is: Echo does not switch its identity. |
| `token` | `string` | none | An initial token (JWT), used before the first token request. Every new client created by `echo.connect()` gets it again: after a login or logout, pass a fresh token or omit it. |
| `autoConnect` | `boolean` | `true` | An Ably client option. With `false`, the connection waits for `echo.connector.ably.connect()`, and `connectionStatus()` is `"disconnected"` until then. |
| `endpoint` | `string` | not set (Ably's default) | Ably's endpoint. `environment`, `realtimeHost` and `restHost` are mapped to it, with a warning. |
| `httpRequestTimeout` | `number` (ms) | `10000` | Also applies to the request to `authEndpoint`. |
| `withoutInterceptors` | `boolean` | `false` | Set `true` to skip the `X-Socket-Id` request interceptors. |

### Socket ID before the connection is up

In 1.x, `socketId()` returned `''` until the connection had a key. In 2.0.0 it returns `undefined`, as upstream's connectors do. Compare it with a falsy value (`if (!echo.socketId())`), not with `''`. No `X-Socket-Id` header is sent before the connection is up, so a request made then is not excluded by `toOthers()`; there is nothing to change on the server.

### Connection status

`echo.connectionStatus()` returns `"connected"`, `"connecting"`, `"reconnecting"`, `"disconnected"` or `"failed"`, and `echo.onConnectionChange(callback)` reports each change and returns an unsubscribe function. The README lists [how Ably's connection states map](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/laravel-echo/README.md#connection-status) to these values.

`echo.onConnectionChange()` is specific to this fork and is the recommended API: unlike `echo.connector.onConnectionChange()`, it keeps working after `echo.connect()` replaces the connector.

During Echo's own reconnect for a client ID change (login, logout, user switch), Ably briefly reports `failed` (40102). Echo reports it as `"reconnecting"`. An Ably listener of your own that listens to every state change (`echo.connector.ably.connection.on(callback)`) and reads `echo.connectionStatus()` synchronously at that moment sees `"failed"`. `onConnectionChange()` callbacks get the right status.

<a id="pusher-reverb-and-socketio"></a>

### Pusher, Reverb and Socket.IO

`@ably/laravel-echo` keeps upstream's `reverb`, `pusher`, `socket.io`, `mercure` and `null` broadcasters, unchanged, and does not include their client libraries:

- **Pusher and Reverb:** install `pusher-js` and pass it as `Pusher`, or set `window.Pusher`. In the React, Vue and Svelte packages this differs from upstream, whose `configureEcho()` imported `pusher-js` and passed it for you:

    ```js
    import Pusher from "pusher-js";
    import { configureEcho } from "@ably/laravel-echo-react";

    configureEcho({ broadcaster: "reverb", Pusher });
    ```

    Without it, the first `echo()` call after `configureEcho()`, which every hook makes, throws an error that names both ways.

- **Socket.IO:** pass the `io` function of `socket.io-client` as `client`, or set `window.io`, in the core and in the framework packages alike. This is the same as upstream; without it Echo throws `Socket.io client not found`.

### `broadcaster` is optional

`new Echo({})` and `configureEcho({})` use the native Ably connector. `null` or a missing `broadcaster` both mean `"ably"`. With an explicit `broadcaster`, `echo.options` is your options object, as upstream; with the default, it is a copy with `broadcaster: "ably"` added.

<a id="typescript"></a>

### TypeScript

- `echo.options.broadcaster` keeps upstream's non-optional type. Assigning an options object without `broadcaster` to `echo.options` is a type error, as it is upstream. The type `EchoOptions<"ably">["broadcaster"]` includes `undefined`, because the option is optional.
- **`skipLibCheck`.** Laravel's and Vite's default `tsconfig.json` sets `skipLibCheck: true`, which needs nothing else. With `skipLibCheck: false`, install `pusher-js` (its types are referenced, as upstream) and `@types/node`, and add `"node"` to `compilerOptions.types`: Ably's SDK types reference Node's `Buffer`.

<a id="requesttokenfn"></a>

### `requestTokenFn`

`requestTokenFn(channelName, existingToken)` replaces the request to `authEndpoint`:

- `channelName` is `null` for the connection token, and a channel name such as `private:orders` for a channel;
- `existingToken` is `null` until Echo has a token;
- it must resolve with your server's token response, `{ token, info? }` (`info` is the presence member data);
- each call is bounded to 30 s. Don't wrap it in try/catch: Echo handles its errors.

A function typed `(channelName: string, existingToken: string)`, as in the 1.x README, still compiles.

### MAU-billed accounts and 40161

laravel-broadcaster 2.x gives every guest a client ID, so guests connect on MAU-billed Ably accounts without any setting. A connection without a client ID, for example with a token from your own endpoint, still fails with 40161, and Echo 2.0.0 logs this hint once:

> Your Ably account requires an identified client on every connection (MAU billing), but this connection has no clientId. Use laravel-broadcaster v2, which always issues guest client ids, or make sure your auth endpoint returns a token with a clientId.

The hints for 40168 and 40167 are unchanged.

### Unchanged from 1.1

Login, user switches and logout without a page reload, other open tabs, CSRF tokens, `error()` after a switch and the known limitations work as described for 1.1 below, except for the MAU setting, which laravel-broadcaster 2.x no longer needs.

### Rolling back to 1.1

Roll back both packages together: `@ably/laravel-echo` 1.1.x with laravel-broadcaster 1.x (see [Staying on 1.x](https://github.com/ably/laravel-broadcaster/blob/main/UPDATING.md#staying-on-1x)). Restore the MAU option on the server if your Ably account is MAU-billed, as described in the 1.1 section below.

<a id="10x--110"></a>

## 1.0.x → 1.1

`@ably/laravel-echo` 1.1 is a minor release. The Echo API (`channel`, `private`, `join`, `listen`, `whisper`, `here`, `error`, `socketId`, …) and its options are unchanged, so most applications only change the install line and drop the `window.Ably` lines from their initialization.

What changed is how Ably's library is installed: 1.1 depends on Ably's [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) v3 and installs it itself, so you no longer install or expose `ably`. It also adds client ID switching without a page reload (login, user switch, logout, and the same changes made in another tab) and support for Ably accounts with monthly-active-user (MAU) pricing.

Publish order: Echo 1.1 must be published before, or together with, [laravel-broadcaster](https://github.com/ably/laravel-broadcaster) 1.1, whose documentation tells users to install `@ably/laravel-echo@^1.1`. For the server side (guest client IDs, token lifetime, `ABLY_MAU_ACCOUNT`), see that repository.

### Mapping

| 1.0.x | 1.1.x |
| --- | --- |
| `npm install @ably/laravel-echo ably@1.x` | `npm install @ably/laravel-echo@^1.1` |
| `import * as Ably from 'ably'; window.Ably = Ably;` | remove (harmless if left; Echo ignores it and logs a one-time `console.warn`) |
| `ably` dependency | remove if nothing else uses it |
| Ably CDN `<script>` with `dist/echo.iife.js` | remove: the IIFE build includes `@ably/pubsub-device` |
| `environment`, `realtimeHost`, `restHost` options | `endpoint` (the old keys are mapped to it with a warning) |
| `echo.connector.ably` is an `ably` `Realtime` client | a `@ably/pubsub-device` `PubSubClient` with promise-based APIs |
| Node.js >= 10 (`engines`) | Node.js >= 22 to install and build |
| after logout: create a new Echo instance | `Echo.connect()` or a new Echo instance |

### Example

```js
// 1.0.x
import Echo from '@ably/laravel-echo';
import * as Ably from 'ably';

window.Ably = Ably; // make globally accessible to Echo
window.Echo = new Echo({
    broadcaster: 'ably',
});

// 1.1
import Echo from '@ably/laravel-echo';

window.Echo = new Echo({
    broadcaster: 'ably',
});
```

### Requirements

- **Node.js 22 or later** to install and build (it affects build machines and CI, not browsers). It is the `engines` field of Echo (`"node": ">=22"`) and of `@ably/pubsub-device` 3.0.0.
- **A bundler that understands ES2020** (webpack 5 or Vite; webpack 4 needs transpiling). `@ably/pubsub-device` publishes ES2020 syntax.

Both are inherited from `@ably/pubsub-device`, not an Echo API change.

### Install and the `Ably` global

- Echo always uses its own copy of `@ably/pubsub-device`. It never reads a global `Ably` or `AblyPubSub`, so a leftover `window.Ably` from ably v1 or v2 cannot break Echo. While one exists, Echo logs one `console.warn`.
- The exception is a client you create yourself and pass as `options.client`: Echo uses it as is, with no warning. A client you pass gets no pre-attach authorization, so its own auth must grant the channel capabilities. `Echo.connect()` does not reopen a client you supplied: call `client.connect()` yourself.
- **Script tag:** `dist/echo.iife.js` includes `@ably/pubsub-device`, so it needs no Ably CDN script or global. It grows from about 116 KB to about 500 KB (about 24 KB to about 105 KB gzipped). The ESM and CJS builds do not include it: your bundler or Node resolves `@ably/pubsub-device`.
- **Pusher, Reverb and socket.io:** apps that use this package only with those broadcasters now also install `@ably/pubsub-device` and include it in their bundle (about 75 KB gzipped, about 50 KB minified). They should use upstream `laravel-echo` instead.
- **Server-side rendering:** create Echo only in the browser, for example `if (typeof window !== 'undefined') { window.Echo = new Echo({ broadcaster: 'ably' }); }`. Echo created during server-side rendering opens a device connection from the server.
- **Using `echo.connector.ably` directly, or passing Ably client options through Echo?** See [Getting started with Ably in JavaScript](https://ably.com/docs/getting-started/javascript) and the [ably-js v3 migration guide](https://github.com/ably/ably-js/blob/main/docs/migration-guides/v3/lib.md). The behaviour changes inherited from ably-js v3 (error shapes, MsgPack in browsers, asynchronous callbacks) are listed there.

### Echo options and defaults

An app that passes its 1.0.x options needs no new option: every option added in 1.1 has a working default. `broadcaster` is not new and still has none. Echo's own options:

| Option | Default | Notes |
| --- | --- | --- |
| `broadcaster` | none (required) | Required; set `'ably'`. Omitting it throws `Broadcaster undefined undefined is not supported.` |
| `authEndpoint` | `'/broadcasting/auth'` | Relative URLs resolve against the page URL. |
| `auth.headers` | `{}` | Extra headers for auth requests. |
| `csrfToken` | `null` | Read in this order: `window.Laravel.csrfToken`, this option, the `<meta name="csrf-token">` tag. Sent as `X-CSRF-TOKEN`. |
| `bearerToken` | `null` | Sent as `Authorization: Bearer …`. |
| `namespace` | `'App.Events'` | Prefix of event names. |
| `requestTokenFn` | none | Replaces the request to `authEndpoint`. Each call is bounded to 30 s. Do not wrap it in try/catch: Echo handles its exceptions. |
| `client` | none | Your own client, used as is (see above). |
| `token` | none | An initial token, used before the first token request. It is not stripped from the client options, so every new client created by `Echo.connect()` gets it again (as in 1.0.x): after a login or logout, pass a fresh token or omit it. |
| `endpoint` | not set (ably-js default) | New in 1.1 (`@ably/pubsub-device` v3), replaces `environment`, `realtimeHost` and `restHost`. |
| `httpRequestTimeout` | `10000` ms | Also applies to the request to `authEndpoint` since 1.1. |
| `withoutInterceptors` | `false` | Set `true` to skip the `X-Socket-Id` request interceptors. |

Every other option is passed to Ably as a client option (for example `echoMessages`, `queueMessages`, `disconnectedRetryTimeout`, `suspendedRetryTimeout`, `tls`); Echo-only keys such as `authEndpoint`, `csrfToken` and `bearerToken` are not. Echo sets `echoMessages: false` itself, and an `echoMessages` you pass overrides it. Ably's auth options (`authUrl`, `authCallback`, …) should not be used, because `authEndpoint` already does token authentication. `host` and `key` are Pusher options and have no effect with Ably.

### Login, user switch and logout in the same page

An Ably connection cannot change its client ID. When the identity of your user changes, Echo has to open a new connection with the new client ID. Echo 1.1 does this for you, as described below (see [Fix clientId mismatch](https://github.com/ably-forks/laravel-echo/pull/38) for the original fix for a guest logging in).

#### Login without a page reload

- **What Echo does:** the next time your page subscribes to a private or presence channel that its current token does not cover, or Ably renews the connection token, Echo gets a token for the new user. Echo then reconnects once with it and subscribes to your existing channels again.
- **What your app sees:** channels that the new user may use work without any `error()` call. Each channel that the new user may not use reports one 403 to `error()`. The short "mismatched clientId" error (40102) that comes with the switch is not passed to `error()` (see [`error()` after a switch](#error-after-a-switch)).
- **What your app should do:** nothing, unless the switch must happen right away. A channel that the current token already covers (an already subscribed one, or one the old user was authorized for) does not trigger a token request, so Echo does not switch for it. To switch immediately, call `Echo.connect()` and subscribe to your channels again. If the login regenerated the CSRF token, refresh it first (see [CSRF tokens](#csrf-tokens-and-419-errors)).

#### Switching users

When one user logs out and another logs in on the same page, Echo handles it like a login. It reconnects once as the new user. This also works for several switches in the same page.

#### Logout without a page reload

- **What Echo does:** nothing on its own. The connection keeps the old user's identity and channel permissions until the next token request. That request happens in one of two cases:
  - Ably renews the connection token shortly before it expires. laravel-broadcaster's default token lifetime is 8 hours.
  - Your app subscribes to a new private or presence channel that the cached token does not cover. The server answers a guest with a 403, and the connection does not switch.

  Channels that are already subscribed never trigger a token request.
- **Why this matters:** after a logout without a page reload, the page keeps the old user's identity and its access to the private and presence channels it is already subscribed to. This lasts until the current token expires (up to `token_expiry` in laravel-broadcaster, 8 hours by default).
- **What your app should do:** call `Echo.connect()` (then subscribe to your channels again), or `Echo.disconnect()`, as part of logout. Both close the connection immediately (`Echo.connect()` closes the client Echo created, not an `options.client`), so the old token is no longer used. If you create a new Echo instance instead, call `disconnect()` on the old one first, so its connection closes too. With `Echo.connect()`, Echo then connects as a guest and your broadcaster denies private and presence channels, as for any guest. A shorter token lifetime in laravel-broadcaster (`ABLY_TOKEN_EXPIRY`) shortens this window, at the cost of more token requests; see the [laravel-broadcaster UPDATING.md](https://github.com/ably/laravel-broadcaster/blob/HEAD/UPDATING.md#logout-without-a-page-reload).
- **If your app does nothing:** at the next token renewal, Echo notices the new identity (a guest ID, or no client ID) and reconnects once with it. Public channels keep working without any `error()` call. Each private and presence channel reports one 403 to `error()`, because the new identity may not use them. The brief `failed` state (40102) during the reconnect is hidden from `error()`. A new private or presence subscription that needs a token request gets a 403 and does not switch the connection; one that the old token still covers attaches without a request until that token expires.
- **Exceptions:** `Echo.connect()` connects as a guest unless a signed-in `token` option is still set (see the `token` option above). `Echo.connect()` does not close a client you passed as `options.client`: see below.

#### If you pass your own Ably client

If you pass your own Ably client (`options.client`), Echo uses it as it is and leaves its identity to you: Echo does not switch or re-authenticate it, and `Echo.connect()` does not close it (`Echo.disconnect()` does). To change the user, update that client's authentication or replace it.

#### MAU-billed accounts

On an MAU-billed Ably account, a switch to no client ID is rejected with 40161. The connection stays `failed` and does not retry, and Echo logs a console hint once. To avoid this, first make your server issue guest IDs (`ABLY_MAU_ACCOUNT=true` in laravel-broadcaster). Without them, `Echo.connect()` after a logout fails with 40161 again. See [Guest users on MAU-billed Ably accounts](#guest-users-on-mau-billed-ably-accounts).

#### CSRF tokens and 419 errors

Login regenerates the CSRF token, and so does the standard logout (session invalidate and `regenerateToken()`). An outdated CSRF token makes the auth request fail with 419. Echo copies the CSRF header once, when it is created (`setOptions`), and every token request reuses it. So after a login or logout that regenerated the CSRF token (the default in Laravel), refresh it before `Echo.connect()`.

A tab that does not call `Echo.connect()` keeps its old CSRF header. It can get a 419 at its next token renewal. Refresh the CSRF token and call `Echo.connect()`, or reload the page.

Echo reads the CSRF token from `window.Laravel.csrfToken` first, then the `csrfToken` option, then the `<meta name="csrf-token">` tag. The first one that is set wins. Refresh that one, or remove a stale one that has higher priority.

### Logout or login in another tab

Other open tabs switch to the new identity by themselves: a guest, no client ID, or another user. A tab switches the next time it gets a token for a different identity. That happens:

- At the latest when the connection token is renewed. Ably asks for a new token shortly before the current one expires, or when it reconnects after the old one expired. This can take up to the token lifetime. laravel-broadcaster's `token_expiry` is 28800 s (8 hours) by default.
- Earlier after a login, if the tab subscribes to a private or presence channel that its token does not cover. This is the same path as a login in the same page.

When a tab switches, Echo reconnects once with the new identity and subscribes to the tab's channels again. Echo asks your server to authorize each private and presence channel again. The connection briefly reports `failed` (40102) during the switch. Echo does not pass this to `error()`.

What `error()` receives:

- After a login, channels that the new user may use work without any `error()` call. Other channels report one 403.
- After a logout, `error()` receives one 403 per private or presence channel.
- On MAU-billed accounts without guest client IDs, a switch to no client ID fails with 40161 (see [Guest users on MAU-billed Ably accounts](#guest-users-on-mau-billed-ably-accounts)).

The token request must succeed for a tab to switch. A tab that keeps its old CSRF header gets a 419 and does not switch until its CSRF token is refreshed and `Echo.connect()` is called (see [CSRF tokens](#csrf-tokens-and-419-errors)). Echo does not switch a client you pass as `options.client` (see above).

To switch every tab at once, tell the other tabs to call `Echo.connect()`, for example with a [`BroadcastChannel`](https://developer.mozilla.org/docs/Web/API/BroadcastChannel):

```js
const authTabs = new BroadcastChannel('auth');

function reconnect() {
    // the receiving tab must install the fresh CSRF token first (or reload): Echo cannot fetch one for it
    window.Echo.connect();
    // then subscribe to your channels again
}

authTabs.onmessage = reconnect;

// in the tab that logged in or out, once the request has succeeded:
authTabs.postMessage('identity-changed');
reconnect(); // a BroadcastChannel object does not receive its own messages
```

### `error()` after a switch

- **Switch that Echo starts (a login, or another user logging in):** Echo drops the first "mismatched clientId" error (40102) of each channel. It does not report it to `error()` while the switch is in progress, which is until the connection is back, at most 30 s. Echo still reports other errors.
- **Switch on token renewal (a login or logout in another tab):** Echo also drops the first 40160 of each private or presence channel. Echo recovers from it by authorizing the channel again.
- **Per channel:** `error()` is per channel. Your app never receives the connection's own `failed` state, including the brief `failed` (40102) of a switch.
- **Denied channels:** if your broadcaster denies a private or presence channel after a switch, `error()` receives the denial once (HTTP 403, `statusCode` 403, `code` 40300).

Error codes you may meet around a switch:

| Code | Plain meaning | What to do |
| --- | --- | --- |
| 40102 | The connection's client ID does not match the new identity. | Nothing, for the brief one during a switch: Echo reconnects and hides the first one per channel from `error()`. Any other 40102 reaches `error()`. |
| 40160 | The cached token does not allow this private or presence channel yet. | Nothing. Echo authorizes the channel again. |
| 40161 | A guest connected without a client ID on an MAU-billed account. | Enable guest client IDs (see below). |
| 40167 | A server-side Ably client's token lacks what a MAU-billed account requires of server clients. | Fix token issuing on your server; it is not a browser issue. |
| 40168 | An incompatible or older Ably SDK build connected. | Use `@ably/laravel-echo` 1.1 or later and remove any global `ably` package. Make sure no other Ably SDK creates the connection. |
| 403 (40300) | Your broadcaster denied the channel for this identity. | Nothing, if the denial is expected. |
| 419 | The CSRF token is outdated (the auth request failed). | Refresh the CSRF token, then call `Echo.connect()`. |

### Guest users on MAU-billed Ably accounts

Every device connection on an MAU-billed account must carry a client ID, so a guest connection without one is rejected with error 40161. To serve guests:

1. Deploy Echo 1.1 to your users before turning the flag on. Use laravel-broadcaster 1.1 or later and set `ABLY_MAU_ACCOUNT=true` in `.env`. It only takes effect if `config/broadcasting.php` has these lines in the `ably` connection (the package ships no config file):

   ```php
   'mau_account' => env('ABLY_MAU_ACCOUNT', false),
   'guest_id_prefix' => env('ABLY_GUEST_ID_PREFIX', 'guest:'),
   ```

   Guests then get a broadcaster-issued guest client ID, and login, user switch and logout work as described above. The `guest:` prefix (`ABLY_GUEST_ID_PREFIX`) is cosmetic and not reserved. Each guest id counts as a monthly active user (with the built-in guest ids, a logout starts a fresh id on routes with a session; ids from a resolver are your app's job).
2. Otherwise, only connect Echo for signed-in users.

With `ABLY_MAU_ACCOUNT` off on an MAU-billed account, guests fail with 40161 and Echo 1.1.x logs this hint to the console, once (Echo 2.0.0 logs a different hint, see [MAU-billed accounts and 40161](#mau-billed-accounts-and-40161)):

> Your Ably account requires an identified client on every connection (MAU billing), but this guest connected without a clientId. In laravel-broadcaster set ABLY_MAU_ACCOUNT=true (config broadcasting.connections.ably.mau_account) so guests receive a clientId, or only connect Echo for signed-in users. See "Guest users on MAU-billed Ably accounts" in the README.

(The 1.1.x README has a short section with this name; the details are here.) Echo logs a hint, once per code, for three MAU error codes: 40161 (a guest without a client ID), 40168 (an incompatible or older Ably SDK build: make sure a single, up-to-date `@ably/pubsub-device` is installed) and 40167 (a server-side client whose token lacks what MAU accounts require; a token-issuing issue, not a browser one).

### Known limitations

- A logout or login in another tab reaches this tab at its next connection token renewal at the latest. That can take up to `token_expiry` (8 hours by default). After a login, the tab can switch earlier if it subscribes to a private or presence channel that its token does not cover. Call `Echo.connect()` in every tab to switch at once.
- Every client ID switch uses a fresh connection, not a resume, so messages published while the connection switches are not delivered. Apps that need them can use channel `rewind` or history.
- Access to private and presence channels can be lost briefly when the connection token is renewed after it expired. laravel-broadcaster keeps a token's private and presence channel access only while that token is unexpired. So the renewed token allows only public channels, and private and presence channels fail with 40160. Echo authorizes them again, but messages broadcast in that gap are lost. This is how laravel-broadcaster behaves (see [laravel-broadcaster issue 55](https://github.com/ably/laravel-broadcaster/issues/55)).

### Unchanged

The Echo API and its options (listed above), the channel names (`public:`, `private:`, `presence:`), `socketId()` and the `requestTokenFn` and auth endpoint contract.

### Rolling back

Pin the previous release and restore the 1.0.x install and initialization (`window.Ably = Ably`): `npm install @ably/laravel-echo@1.0.6 ably@1`. On an MAU-billed Ably account 1.0.x is rejected (40168), so only roll back if your account is not MAU-billed.
