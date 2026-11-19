# Changelog

## [v1.1.0](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.1.0)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.0.6...ably-echo-1.1.0)

Echo's API is unchanged. See [UPDATING.md](UPDATING.md#10x--110) for the upgrade steps.

### Changed

- Echo now depends on `@ably/pubsub-device@^3` and installs it itself (`npm install @ably/laravel-echo@^1.1`); `ably@1.x` and `ably@2.x` are no longer used. Echo always uses its own copy and ignores a global `Ably` or `AblyPubSub` (one-time `console.warn`); a client passed as `options.client` is still used as is. `echo.connector.ably` is now a `PubSubClient` with promise-based APIs. Apps that use this package only with Pusher, Reverb or socket.io now also bundle `@ably/pubsub-device` (about 75 KB gzipped). See [UPDATING.md](UPDATING.md#install-and-the-ably-global).
- Installing and building requires Node.js 22 or later and a bundler that understands ES2020 (inherited from `@ably/pubsub-device`; browsers are unaffected).
- On MAU-billed Ably accounts, guest connections without a client ID are rejected with 40161: set `ABLY_MAU_ACCOUNT=true` in laravel-broadcaster 1.1.0 or later, or only connect Echo for signed-in users. See [UPDATING.md](UPDATING.md#guest-users-on-mau-billed-ably-accounts).
- The script-tag build `dist/echo.iife.js` now includes `@ably/pubsub-device` (about 500 KB instead of about 116 KB; about 105 KB instead of about 24 KB gzipped). The ESM and CJS builds don't include it.
- During a client ID switch that Echo starts, the short "mismatched clientId" error (40102) is no longer reported to `error()`. Echo drops the first one per channel, until the connection is back or for at most 30 s. After a switch on token renewal (a login or logout in another tab), Echo also drops the first 40160 of each private or presence channel while it subscribes again, for at most 30 s. Echo recovers from it by authorizing the channel again. Other errors are still reported. See [UPDATING.md](UPDATING.md#error-after-a-switch).
- The MAU console hint is logged only for 40161, 40168 and 40167, once per code, with a specific explanation for each.
- Logout: call `Echo.connect()` or `Echo.disconnect()` as part of logout, or the page keeps the old user's channel access until its token expires. `Echo.connect()` then connects as a guest, unless a signed-in `token` option is still set. Echo does not switch a client passed as `options.client`: change its authentication or replace it.

### Added

- Login and user switch without a page reload (for logout, see the Logout bullet above). Echo now reconnects with the new client ID and subscribes to your channels again, for guest to user and user to another user, including several switches in one page. On MAU-billed accounts this needs guest client IDs (`ABLY_MAU_ACCOUNT=true` in laravel-broadcaster). See [UPDATING.md](UPDATING.md#login-user-switch-and-logout-in-the-same-page).
- A logout or login in another tab is picked up at the next token request for another identity, at the latest at the next connection token renewal. The tab reconnects once as the new identity (a guest, no client ID or another user) and subscribes to its channels again. Echo authorizes private and presence channels again. Previously the tab stayed disconnected and then `failed`, or stayed connected with a stale client ID. Call `Echo.connect()` in every tab to switch at once. See [UPDATING.md](UPDATING.md#logout-or-login-in-another-tab).

### Fixed

- A private or presence channel subscribed while the connection is still connecting (for example right after `Echo.private()` at startup) no longer aborts and restarts the connection attempt: Echo waits for `connected` before its pre-attach authorize(), so the attempt is not restarted. Echo waits from `initialized`, `connecting` or `disconnected`; if the connection is `failed`, `suspended`, `closing` or `closed`, at the call or while waiting, the attach fails with that error. Covered by the `defer-authorize` parity tests.
- Callbacks of `whisper`, `enter`, `update`, `leave` and `here` run exactly once; exceptions in callbacks and listeners no longer become unhandled promise rejections or stop other listeners.
- One attach failure is reported to `error()` once, also when both the channel state change and the `attach()` rejection report it (the state-change payload is unchanged); subscribe errors that no channel state change reported still reach `error()`.
- Auth endpoint: cookies are sent cross-origin only for a lowercase `authorization` header, as with ably 1.x and 2.x; error codes come from the HTTP status; invalid tokens are rejected with code 50000 and no longer replace the cached token; a `requestTokenFn` that never settles no longer blocks other token requests forever (each request is bounded by 30 s; an auth-endpoint request by `httpRequestTimeout` + 1 s if that is longer); `httpRequestTimeout` applies to auth requests.
- `environment`, `realtimeHost` and `restHost` are mapped to `endpoint` with a warning instead of being ignored.
- `import { Channel } from '@ably/laravel-echo'` works again.
- After `Echo.disconnect()`, Echo no longer reopens the connection by itself (for example when a token request finishes late, or a private channel is authorized); call `Echo.connect()` to reconnect (with `options.client`, `Echo.connect()` does not reopen the client you supplied: call `client.connect()` yourself).
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

- Another tab's logout or login reaches this tab at its next connection token renewal at the latest (up to laravel-broadcaster's `token_expiry`, 8 hours by default).
- Every client ID switch uses a fresh connection, not a resume: messages published while it switches are not delivered.
- Private and presence channels can lose access briefly when the connection token is renewed after it expires: the renewed token gets public claims only, and Echo re-authorizes private and presence channels as they report 40160 (see https://github.com/ably/laravel-broadcaster/issues/55; the sandbox test for it (`token-renewal`) now checks the renewal behaviour of the fixed broadcaster instead, see Internal changes).

Details and workarounds: [Known limitations](UPDATING.md#known-limitations).

### Internal changes

- Internal behaviour changes inherited from ably-js v3 (error shapes, MsgPack in browsers, subscribe-capability errors, asynchronous callbacks, and failures of `whisper`, `enter`, `update` and `leave` called without a callback now reach `error()` listeners); see the ably-js v3 migration guide: https://github.com/ably/ably-js/blob/main/docs/migration-guides/v3/lib.md. Pull requests: https://github.com/ably-forks/laravel-echo/pull/50, https://github.com/ably-forks/laravel-echo/pull/51, https://github.com/ably-forks/laravel-echo/pull/52, https://github.com/ably-forks/laravel-echo/pull/53.
- CI runs the Ably tests against both the Node and the browser build of `@ably/pubsub-device`; the browser-build job is blocking.
- Sandbox tests: `MockAuthServer` has `renewalMode` (`'reverify'` by default, as the fixed broadcaster; `'reuse'` is the old behaviour) and `revoke()`; and `token-renewal` runs 60 s tokens across several renewals (a token of 30 s or less always renews in a loop, by design) and checks the connection id stays the same, no 40142 or disconnect, growing token expiry, attached channels and the presence member staying present.
- MAU e2e tests now run against a real MAU-enforced sandbox app (`mauEnforced`) instead of a local proxy.

### Release

- 1.1.0 is published straight to `latest` (no `next` tag, no beta) once PRs 54, 55, 56 and the README/UPDATING.md docs PR are merged, so a `^1.0` range resolves to 1.1.0 after that.
- Rollback: see "Rolling back" in [UPDATING.md](UPDATING.md#rolling-back).

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
