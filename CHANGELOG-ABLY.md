# Changelog

## [v1.1.0](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.1.0)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.6...ably-echo-1.1.0)

Echo's API is unchanged. See "Upgrading to 1.1" in the README.

### Changed

- Echo now depends on `@ably/pubsub-device@^3` and installs it itself (`npm install @ably/laravel-echo@^1.1`); `ably@1.x` and `ably@2.x` are no longer used. Echo always uses its own copy and ignores a global `Ably` or `AblyPubSub`, so the 1.0.x snippet `window.Ably = Ably` (or `require('ably')`) can stay but can be removed; while it is there, Echo logs a one-time `console.warn`. A client passed as `options.client` is still used as is. `echo.connector.ably` is now a `PubSubClient` with promise-based APIs. Apps that use this package only with Pusher, Reverb or socket.io now also install `@ably/pubsub-device` and include it in their bundle (about 75 KB gzipped, about 50 KB when minified); they should use upstream `laravel-echo`.
- Installing and building requires Node.js 22 or later and a bundler that understands ES2020 (webpack 5 or Vite; webpack 4 needs transpiling). Both are inherited from `@ably/pubsub-device`, not an Echo API change; browsers are unaffected.
- On MAU-billed Ably accounts, device connections must carry a client ID, so guest connections without one are rejected with 40161. Set `ABLY_MAU_ACCOUNT=true` in laravel-broadcaster 1.1.0 or later so guests get a client ID, or only connect Echo for signed-in users.
- The script-tag build `dist/echo.iife.js` now includes `@ably/pubsub-device`, so it needs no Ably CDN script or global: about 500 KB instead of about 116 KB (about 105 KB instead of about 24 KB gzipped). The ESM and CJS builds don't include it; the app's bundler or Node resolves `@ably/pubsub-device`.
- During a client ID switch that Echo starts (login, or another user logging in), the transient "mismatched clientId" error (40102) is no longer reported to `error()`: the first one per channel is dropped until the connection is back, or for at most 30 s. Other errors are still reported.
- The MAU console hint is logged only for 40161, 40168 and 40167, once per code, with a specific explanation for each; 40161 names `ABLY_MAU_ACCOUNT=true` (`broadcasting.connections.ably.mau_account`).
- Logout: call `Echo.connect()` or create a new Echo instance; Echo then connects as the guest (see the README).

### Added

- A client ID switch on the same Echo instance: guest to user, and user to another user, including several switches in one page, now reconnects with the new client ID and re-attaches the channels (on MAU-billed accounts this needs guest client IDs from laravel-broadcaster `ABLY_MAU_ACCOUNT=true`).
- A logout or login in another tab is picked up at this tab's next token renewal (after up to the token lifetime): the connection reconnects once as the new identity (guest, no client ID or another user), typically within a second or two (when Ably asks the connected client to re-authenticate, it briefly reports `failed` with 40102, which is not passed to `error()`), and re-attaches its channels; private and presence channels are authorized again, with no `error()` call after a login and one 403 per private or presence channel after a logout (the transient 40160 of the re-attach is not reported). On MAU-billed accounts without guest client IDs, a switch to no client ID fails with 40161. Previously it stayed disconnected and then `failed`, or stayed connected with a stale client ID. Call `Echo.connect()` in every tab (for example through a `BroadcastChannel`) to switch at once.

### Fixed

- Callbacks of `whisper`, `enter`, `update`, `leave` and `here` run exactly once; exceptions in callbacks and listeners no longer become unhandled promise rejections or stop other listeners.
- One attach failure is reported to `error()` once, also when both the channel state change and the `attach()` rejection report it (the state-change payload is unchanged); subscribe errors that no channel state change reported still reach `error()`.
- Auth endpoint: cookies are sent cross-origin only for a lowercase `authorization` header, as with ably 1.x and 2.x; error codes come from the HTTP status; invalid tokens are rejected with code 50000 and no longer replace the cached token; a `requestTokenFn` that never settles no longer blocks other token requests forever (each request is bounded by 30 s; an auth-endpoint request by `httpRequestTimeout` + 1 s if that is longer); `httpRequestTimeout` applies to auth requests.
- `environment`, `realtimeHost` and `restHost` are mapped to `endpoint` with a warning instead of being ignored.
- `import { Channel } from '@ably/laravel-echo'` works again.
- Attach and presence edge cases: concurrent attaches during authorization (a caller that awaits its attach is rejected when the authorization or the ATTACH fails), leaving a channel while it authorizes, `stopListening` / `stopListeningToAll` bookkeeping (`stopListeningToAll()` no longer removes `listen()` listeners), `listenToAll` with `namespace: false`, no duplicate presence enter after a resumed reconnect, and a re-enter when the last `enter()` failed.
- Channels subscribed before a failed connection are re-attached when it recovers, for example after login or a user switch.
- The pre-attach authorize hook is per client: each Echo instance uses its own authorizer, and clients Echo doesn't create use ably's attach unchanged.
- Echo-only options (auth headers, bearer and CSRF tokens) are no longer passed into the Ably client options.
- Socket IDs and tokens with non-Latin-1 client IDs work in browsers.
- `private()`, `join()` and `leaveChannel()` work with `options.client`; `encryptedPrivate()` throws a clear error with the Ably broadcaster; relative auth endpoints resolve against the page URL; cached-token capabilities are matched by channel name.
- Calling `Echo.connect()` (or the connector's `connect()`) again leaves the existing Echo channels and closes the previous Ably client (a user-supplied `options.client` is not closed); callers re-subscribe after `connect()` is called again.
- The `token` option is still passed to the Ably client (as in 1.0.6), so a configured initial token is used before `authCallback`.
- A hung `requestTokenFn` is bounded by 30 s, independent of `httpRequestTimeout`.
- `socketId()` works with very large clientIds.
- A supplied `options.client` no longer keeps Echo's recovery listeners after `Echo.connect()` is called again.
- A supplied `options.client` that is already `failed` when Echo connects has its channels re-attached when it recovers.

### Known issues

- Another tab's logout or login reaches this tab only at its next connection token renewal (up to laravel-broadcaster's `token_expiry`, 8 hours by default). Call `Echo.connect()` in every tab, for example from a `BroadcastChannel` message, to switch at once.
- Every client ID switch uses a fresh connection, not a resume, so messages published while the connection switches (about a second) are not delivered. Apps that need them can use channel `rewind` or history.
- Access to private and presence channels can be lost briefly when the connection token is renewed after it expires: laravel-broadcaster keeps a token's channel capabilities only while that token is unexpired, so the renewed token has only the `public:*` capability, private and presence channels fail with 40160 and are re-authorized, and messages broadcast in that gap are lost. This needs a laravel-broadcaster fix; the sandbox test for it is skipped until then.

### Internal changes

- Internal behaviour changes inherited from ably-js v3 (error shapes, MsgPack in browsers, subscribe-capability errors, asynchronous callbacks, and failures of `whisper`, `enter`, `update` and `leave` called without a callback now reach `error()` listeners); see the ably-js v3 migration guide: https://github.com/ably/ably-js/blob/main/docs/migration-guides/v3/lib.md. Pull requests: https://github.com/ably-forks/laravel-echo/pull/50, https://github.com/ably-forks/laravel-echo/pull/51, https://github.com/ably-forks/laravel-echo/pull/52, https://github.com/ably-forks/laravel-echo/pull/53.
- CI runs the Ably tests against both the Node and the browser build of `@ably/pubsub-device`; the browser-build job is blocking.

### Release

- 1.1.0 is published with the `next` dist-tag first (`npm publish --tag next`); install it with `npm install @ably/laravel-echo@next` during the beta period. `latest` stays 1.0.6, so a `^1.0` range keeps resolving to 1.0.6, until 1.1.0 is promoted with `npm dist-tag add @ably/laravel-echo@1.1.0 latest`, without a second version bump.
- Rollback: pin the previous release, `npm install @ably/laravel-echo@1.0.6 ably@1`.
- Create Echo only in the browser, for example `if (typeof window !== 'undefined') { window.Echo = new Echo({ broadcaster: 'ably' }); }`: Echo created during server-side rendering opens a device connection from the server.

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
