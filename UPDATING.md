# Upgrade / Migration Guide

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

An app that passes its 1.0.x options needs no new option: everything added in 1.1 has a working default. Echo's own options:

| Option | Default | Notes |
| --- | --- | --- |
| `broadcaster` | `'pusher'` | Set `'ably'`. |
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

With `ABLY_MAU_ACCOUNT` off on an MAU-billed account, guests fail with 40161 and Echo logs this hint to the console, once:

> Your Ably account requires an identified client on every connection (MAU billing), but this guest connected without a clientId. In laravel-broadcaster set ABLY_MAU_ACCOUNT=true (config broadcasting.connections.ably.mau_account) so guests receive a clientId, or only connect Echo for signed-in users. See "Guest users on MAU-billed Ably accounts" in the README.

(The README has a short section with this name; the details are here.) Echo logs a hint, once per code, for three MAU error codes: 40161 (a guest without a client ID), 40168 (an incompatible or older Ably SDK build: make sure a single, up-to-date `@ably/pubsub-device` is installed) and 40167 (a server-side client whose token lacks what MAU accounts require; a token-issuing issue, not a browser one).

### Known limitations

- A logout or login in another tab reaches this tab at its next connection token renewal at the latest. That can take up to `token_expiry` (8 hours by default). After a login, the tab can switch earlier if it subscribes to a private or presence channel that its token does not cover. Call `Echo.connect()` in every tab to switch at once.
- Every client ID switch uses a fresh connection, not a resume, so messages published while the connection switches are not delivered. Apps that need them can use channel `rewind` or history.
- Access to private and presence channels can be lost briefly when the connection token is renewed after it expired. laravel-broadcaster keeps a token's private and presence channel access only while that token is unexpired. So the renewed token allows only public channels, and private and presence channels fail with 40160. Echo authorizes them again, but messages broadcast in that gap are lost. This is how laravel-broadcaster behaves (see [laravel-broadcaster issue 55](https://github.com/ably/laravel-broadcaster/issues/55)).

### Unchanged

The Echo API and its options (listed above), the channel names (`public:`, `private:`, `presence:`), `socketId()` and the `requestTokenFn` and auth endpoint contract.

### Looking ahead: v2

Planned: Echo v2 syncs with upstream laravel/echo 2.x and adds React, Vue and Svelte packages. It will work only with laravel-broadcaster v2, which always issues guest client IDs, so upgrade both together. See https://github.com/ably-forks/laravel-echo/issues/58 and https://github.com/ably/laravel-broadcaster/issues/75.

Connection status in v2: `echo.connectionStatus()` and `echo.onConnectionChange(callback)` (which returns an unsubscribe function). `Echo.onConnectionChange` is fork-only and is the recommended API: unlike `echo.connector.onConnectionChange`, it keeps working after `echo.connect()` replaces the connector.

### Rolling back

Pin the previous release and restore the 1.0.x install and initialization (`window.Ably = Ably`): `npm install @ably/laravel-echo@1.0.6 ably@1`. On an MAU-billed Ably account 1.0.x is rejected (40168), so only roll back if your account is not MAU-billed.
