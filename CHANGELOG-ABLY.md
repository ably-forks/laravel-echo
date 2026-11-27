# Changelog

## [v2.0.0](https://github.com/ably-forks/laravel-echo/tree/ably-echo-2.0.0)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.1.1...ably-echo-2.0.0)

Echo 2.0.0 is a major release. It syncs the fork with upstream `laravel/echo` 2.x and adds React, Vue and Svelte packages. It works only with [laravel-broadcaster](https://github.com/ably/laravel-broadcaster) 2.0.0 or later, which always gives guests a client ID. The Echo API, the Ably channel names and the auth endpoint contract are unchanged, so most apps that use the `ably` broadcaster change only the install line.

Please refer to [UPDATING.md](UPDATING.md#1x--200) for the full details, including every breaking change.

### What you need to do

1. **Upgrade laravel-broadcaster and Echo together:** laravel-broadcaster 2.0.0 and `@ably/laravel-echo` 2.0.0, deployed in the same release. Mixed versions are not supported. Apps that stay on laravel-broadcaster 1.x stay on Echo 1.1.x. See [Upgrade order](UPDATING.md#upgrade-order).
2. **Install the new version:** run `npm install @ably/laravel-echo@^2`. Use Node.js 22 or later to install and build, and a bundler that understands ES2022 syntax.
3. **Remove the MAU option from your server config:** laravel-broadcaster 2.x always issues guest client IDs.
4. **Check the [breaking changes](UPDATING.md#breaking-changes)**, in particular if you use TypeScript, a custom connector, `socketId()`, deep imports, or the `pusher`, `reverb` or `socket.io` broadcasters.

### New

- **React, Vue and Svelte packages:** `@ably/laravel-echo-react`, `@ably/laravel-echo-vue` and `@ably/laravel-echo-svelte`, Ably's ports of upstream's framework packages. They use the native Ably connector by default (`configureEcho({})`) and have a peer dependency on `@ably/laravel-echo`. All four packages share one version number.
- **Connection status:** `echo.connectionStatus()` maps Ably's connection state to `connected`, `connecting`, `reconnecting`, `disconnected` or `failed`. `echo.onConnectionChange(callback)` (specific to this fork) reports each change and keeps working after `echo.connect()`. The framework packages add `useConnectionStatus` and `useSocketId`.
- **`broadcaster` is optional** and defaults to `"ably"`: `new Echo({})`.
- **`leaveChannel(name, visibility)`** (specific to this fork) leaves a channel by the name your app used and its visibility.
- **Upstream sync:** the fork now includes upstream `laravel/echo` 2.x up to `fdba6fe` (v2.6.3 and 4 later commits): 374 upstream commits since `9eb317b`. This brings the TypeScript types, the `mercure` broadcaster and the upstream fixes.
- **Troubleshooting hints:** Echo logs a console hint, once per page, when the auth endpoint refuses the connection token request (HTTP 403) or returns a Pusher-protocol response, the signs of Laravel's built-in `ably` broadcaster. See [Troubleshooting](https://github.com/ably-forks/laravel-echo/blob/2.x/packages/laravel-echo/README.md#troubleshooting).
- **Packaging:** an `exports` map with `@ably/laravel-echo/iife`, a CommonJS build that `require()` can load (`dist/echo.common.cjs`), and an IIFE global `Echo` that also supports upstream's `Echo.default`.

### Breaking changes

See [UPDATING.md](UPDATING.md#breaking-changes) for each one and what to do.

- Echo 2.0.0 works only with laravel-broadcaster 2.0.0 or later, and every connection, including a guest's, has a client ID.
- `socketId()` returns `undefined` until the connection is up (1.x returned `''`).
- The package is `"type": "module"` with an `exports` map, so deep imports no longer resolve. Types are at `dist/echo.d.ts`; `typings/` is no longer shipped. The build target is ES2022.
- A custom `broadcaster` must be a class. Custom connectors must implement `connectionStatus()` and `onConnectionChange()`.
- TypeScript: `Echo` and `Connector` are generic, channel methods return `this`, and `whisper()` takes an object.
- `pusher-js` and `socket.io-client` are optional peer dependencies. The framework packages don't inject `Pusher`: `pusher` and `reverb` users pass `Pusher` or set `window.Pusher`.
- `ably` means the native Ably connector, also in the framework packages. Laravel's built-in `ably` broadcaster is not supported.

### Security

- With the `ably` broadcaster, Echo copies `auth.headers` for each connector. A bearer token or CSRF header no longer leaks from one Echo instance to another: before, the previous user's bearer token could be sent after a logout followed by a new Echo instance. Echo also no longer changes your options object.

### Bug fixes kept from the sync

These fix upstream behaviour without changing the API:

- The Turbo interceptor no longer sends `X-Socket-Id: undefined` before the connection is up.
- The framework packages' `configureEcho()` no longer throws outside Vite (for example from the CommonJS build) because of an unguarded read of `VITE_MERCURE_HUB_URL`.
- Svelte's `useChannel` subscribes to its channel once, not twice, so it now leaves the channel when the component is destroyed.
- A hook that already left a channel (`leaveChannel()`) no longer releases, when it unmounts, the channel that another component subscribed to again.
- `echo.onConnectionChange()` callbacks move to the new connector on `echo.connect()`, and a callback that throws no longer stops the others.
- The CommonJS builds use `.cjs` files, so `require()` works under `"type": "module"`.

## [v1.1.1](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.1.1)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.1.0...ably-echo-1.1.1)

Echo 1.1.1 republishes 1.1.0 with the correct build. There are no source changes.

## [v1.1.0](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.1.0)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.6...ably-echo-1.1.0)

Echo 1.1.0 is a minor release. The Echo API and its options are unchanged, so most apps only change one install line.

You now install a single package. Echo brings Ably's library with it, so you no longer install `ably` or set `window.Ably`. Users can now log in, switch user and log out repeatedly, in this tab or another, without a page reload, and Echo now works with Ably accounts that bill by monthly active users (MAU). The release also fixes problems you may have hit in 1.0.x, such as a private channel that restarted the first connection attempt.

Below is an overview of the main changes. Please refer to [UPDATING.md](UPDATING.md#10x--11) for the full details, including what to change in your app.

### What you need to do

1. **Install the new version:** run `npm install @ably/laravel-echo@^1.1`. This is the only package to install. See [Install and the `Ably` global](UPDATING.md#install-and-the-ably-global).
2. **Remove the Ably lines (optional):** delete `window.Ably = Ably`, the `ably` import and the `ably` dependency if nothing else uses it. If you leave them, Echo ignores them and logs one `console.warn`. Delete an Ably CDN `<script>` tag too, because `dist/echo.iife.js` now includes Ably's library.
3. **Use Node.js 22 or later** on machines that install and build your app, and a bundler that understands ES2020 (webpack 5 or Vite). Browsers are not affected. Older Node versions are not supported: npm warns (or fails with engine-strict), and builds can break. See [Requirements](UPDATING.md#requirements).
4. **Call `Echo.connect()` or `Echo.disconnect()` when a user logs out.** If you do not, the page keeps the old user's access to its private and presence channels until the connection token expires (8 hours by default). See [Logout without a page reload](UPDATING.md#logout-without-a-page-reload).
5. **On a MAU-billed Ably account:** set `ABLY_MAU_ACCOUNT=true` in laravel-broadcaster 1.1.0 or later, or only connect Echo for signed-in users. If you do not, guest connections fail with error 40161. See [Guest users on MAU-billed Ably accounts](UPDATING.md#guest-users-on-mau-billed-ably-accounts).

### Easier install

- You get one package to install, with no matching Ably version to pick. Echo depends on Ably's `@ably/pubsub-device` v3 and always uses its own copy. `ably` 1.x and 2.x are no longer used.
- A client you create yourself and pass as `options.client` is still used as is.
- **Ably client options or `echo.connector.ably`:** `echo.connector.ably` is now a `PubSubClient`, and behaviour inherited from ably-js v3 changed (error shapes, MsgPack in browsers, asynchronous callbacks). See the [ably-js v3 migration guide](https://github.com/ably/ably-js/blob/main/docs/migration-guides/v3/lib.md).
- **Server-side rendering:** create Echo only in the browser, for example `if (typeof window !== 'undefined') { window.Echo = new Echo({ broadcaster: 'ably' }); }`. Echo created during server-side rendering opens a device connection from the server.
- If you use the script-tag build, you no longer need an Ably CDN script. The file `dist/echo.iife.js` grows from about 116 KB to about 500 KB (about 24 KB to about 105 KB gzipped). The ESM and CJS builds do not include Ably's library.
- If you use this package only with Pusher, Reverb or socket.io, your bundle now also includes `@ably/pubsub-device` (about 75 KB gzipped). Use upstream `laravel-echo` instead.
- The old options `environment`, `realtimeHost` and `restHost` are mapped to `endpoint`, with a console warning, so your settings keep working. Switch to `endpoint` when you can.

### Login, user switch and logout without a page reload

- **Login:** a guest who logs in keeps working, as in 1.0.x, and now it keeps working after every further switch. Echo reconnects with the new user's ID and subscribes to your channels again. See [Login, user switch and logout in the same page](UPDATING.md#login-user-switch-and-logout-in-the-same-page).
- **Switching users:** one user can log out and another log in on the same page, as often as needed. Channels the new user may not use report one 403 to `error()`.
- **Other tabs:** a login or logout in another tab now switches this tab too. Before, such a tab stayed disconnected and then failed, or kept a stale user ID.
  - When: at the latest when the connection token is next renewed. The tab reconnects once as the new user and Echo asks your server to authorize its private and presence channels again.
  - To switch every tab at once, call `Echo.connect()` in each of them. See [Logout or login in another tab](UPDATING.md#logout-or-login-in-another-tab).
- **Cleaner errors:** during a switch, the first short "mismatched clientId" error (40102) of each channel is not sent to `error()`. Other errors, and a repeated 40102, still are. See [`error()` after a switch](UPDATING.md#error-after-a-switch).
- **CSRF:** Laravel changes the CSRF token at login and logout. Refresh it before you call `Echo.connect()`, or the auth request fails with 419. See [CSRF tokens and 419 errors](UPDATING.md#csrf-tokens-and-419-errors).
- **Your own client:** Echo does not switch a client that you pass as `options.client`. Change its authentication or replace it.
- **`token` option:** if you set it, every new client from `Echo.connect()` gets it again (as in 1.0.x). After a login or logout, pass a fresh `token` or omit it. See [Echo options and defaults](UPDATING.md#echo-options-and-defaults).

### MAU-billed Ably accounts

- Guests, login, user switch and logout all work on MAU-billed accounts when laravel-broadcaster 1.1.0 or later has `ABLY_MAU_ACCOUNT=true`. The broadcaster then gives each guest a client ID.
- Echo explains the MAU errors 40161, 40168 and 40167 once each in the browser console, with the setting to change.
- Echo 1.0.x is rejected on MAU-billed accounts (error 40168), so do not roll back there.
- If a connection fails and later recovers, for example when a guest is rejected and the user then logs in, Echo attaches the channels you had subscribed to again.
- See [Guest users on MAU-billed Ably accounts](UPDATING.md#guest-users-on-mau-billed-ably-accounts).

### More reliable connections and channels

- **Startup:** a private or presence channel that you subscribe to right after `new Echo(...)` no longer restarts the connection attempt. Echo waits until the connection is `connected`.
- **Disconnect:** after `Echo.disconnect()`, Echo no longer reopens the connection by itself. Call `Echo.connect()` to reconnect.
- **Token renewal:** with laravel-broadcaster 1.1.0 or later, a renewed connection token is a fresh one. Before, the repeated token requests ended in a forced disconnect (40142) at each expiry. Private and presence channels can still lose access for a moment after an expired token is renewed (see [Known limitations](UPDATING.md#known-limitations)).
- **Auth requests:** `httpRequestTimeout` now also applies to the request to your auth endpoint. A custom token function (`requestTokenFn`) that never finishes no longer blocks other requests: each one stops after 30 s. An empty or invalid token gives a clear error and is no longer kept.
- **Auth error codes:** an error from your auth endpoint now has a code taken from the HTTP status (for example 403 gives 40300). If your `error()` handler checks codes, review it.
- **Channel callbacks and listeners:** channels now handle the following correctly:
  - A callback or listener that throws no longer stops the other listeners.
  - A channel you leave while it is being authorized is no longer attached afterwards.
  - Two attaches at the same time no longer interfere.
  - `joining()` and `here()` fire once, not twice, after a reconnect that resumed.
  - `stopListening()` and `stopListeningToAll()` remove exactly the listeners you added. `stopListeningToAll()` no longer removes `listen()` listeners, as with Pusher.
  - `listenToAll` works with `namespace: false`.
  - Socket IDs and tokens work with non-Latin-1 client IDs.
- **Attach errors:** a channel that fails to attach now reports the error to `error()` once. In 1.0.x it could be reported twice.
- **Unchanged from 1.0.6:** callbacks of `whisper`, `enter`, `update`, `leave` and `here` run once, `import { Channel } from '@ably/laravel-echo'` works, and auth requests to a different origin send cookies only when the `authorization` header is set in lowercase.
- **Encrypted private channels:** `encryptedPrivate()` now throws a clear "not supported" error with the Ably broadcaster. In 1.0.x it failed with a confusing TypeError.

## [v1.0.6](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.0.6)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.5...ably-echo-1.0.6)

**Merged pull requests:**

- \[ECO-4995\] Fix base64 url encoding/decoding [\#43](https://github.com/ably-forks/laravel-echo/pull/43) ([sacOO7](https://github.com/sacOO7))
- \[ECO-4977\] Fix broadcast to others [\#42](https://github.com/ably-forks/laravel-echo/pull/42) ([sacOO7](https://github.com/sacOO7))

## [v1.0.5](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.0.5)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.4...ably-echo-1.0.5)

**Closed issues:**

- 401 Error on Subsequent Private/Public Channel Subscriptions [\#36](https://github.com/ably-forks/laravel-echo/issues/36)

**Merged pull requests:**

- Fix clientId mismatch on login [\#38](https://github.com/ably-forks/laravel-echo/pull/38) ([sacOO7](https://github.com/sacOO7))

## [v1.0.4](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.0.4)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.3...ably-echo-1.0.4)

**Closed issues:**

- Update README to use ably-js version \< 2.0 [\#34](https://github.com/ably-forks/laravel-echo/issues/34)
- customInternalAttach -\> authorize -\> errCallback undefined? [\#29](https://github.com/ably-forks/laravel-echo/issues/29)
- Doesn't work with Laravel Sanctum [\#26](https://github.com/ably-forks/laravel-echo/issues/26)

**Merged pull requests:**

- Fix laravel echo version [\#33](https://github.com/ably-forks/laravel-echo/pull/33) ([sacOO7](https://github.com/sacOO7))
- Fix channel preattach errCallback null check [\#31](https://github.com/ably-forks/laravel-echo/pull/31) ([sacOO7](https://github.com/sacOO7))
- Added explicit section to work with laravel sanctum [\#27](https://github.com/ably-forks/laravel-echo/pull/27) ([sacOO7](https://github.com/sacOO7))

## [v1.0.3](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.0.3)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.2...ably-echo-1.0.3)

**Closed issues:**

- Update/Sync project wrt origin [\#21](https://github.com/ably-forks/laravel-echo/issues/21)

**Merged pull requests:**

- Fix/sync fork [\#23](https://github.com/ably-forks/laravel-echo/pull/23) ([sacOO7](https://github.com/sacOO7))
- Update documentation [\#22](https://github.com/ably-forks/laravel-echo/pull/22) ([sacOO7](https://github.com/sacOO7))
- Update README ably clientOptions [\#20](https://github.com/ably-forks/laravel-echo/pull/20) ([sacOO7](https://github.com/sacOO7))
- Replace hosts with env. in clientOptions [\#19](https://github.com/ably-forks/laravel-echo/pull/19) ([sacOO7](https://github.com/sacOO7))

## [v1.0.2](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.0.2)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.1...ably-echo-1.0.2)

**Merged pull requests:**

- Sync changes from upstream laravel echo [\#17](https://github.com/ably-forks/laravel-echo/pull/17) ([sacOO7](https://github.com/sacOO7))
- Fixed presence here method callback data set [\#16](https://github.com/ably-forks/laravel-echo/pull/16) ([sacOO7](https://github.com/sacOO7))

## [v1.0.1](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.0.1)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.0...ably-echo-1.0.1)

**Merged pull requests:**

- Fix ably-echo import in README [\#11](https://github.com/ably-forks/laravel-echo/pull/11) ([sacOO7](https://github.com/sacOO7))
- Implement Ably-Agent header [\#9](https://github.com/ably-forks/laravel-echo/pull/9) ([sacOO7](https://github.com/sacOO7))

## [v1.0.0](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.0.0)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/v1.11.7...ably-echo-1.0.0)

**Merged pull requests:**

- ably-js support for laravel-echo [\#2](https://github.com/ably-forks/laravel-echo/pull/2) ([sacOO7](https://github.com/sacOO7))
