# Changelog

## Unreleased (next release: 2.0.0)

Echo's API is unchanged. See "Upgrading to 2.0" in the README.

### Breaking changes

- The peer dependency is now `@ably/pubsub-device@^3` instead of `ably`; `ably@1.x` and `ably@2.x` are no longer supported. Import it with `import * as Ably from '@ably/pubsub-device'; window.Ably = Ably;` (replace `ably` and `ably/promises` imports; there is no default export). `echo.connector.ably` is now a `PubSubClient` with promise-based APIs.
- With a script tag, the v3 CDN bundle (`https://cdn.ably.com/lib/ably.min-3.js`) exposes `AblyPubSub`; Echo picks it up automatically.
- Installing and building requires Node.js 22 or later (inherited from `@ably/pubsub-device`); browsers are unaffected.
- On MAU-billed Ably accounts, device connections must carry a client ID, so guest connections without one are rejected. Reload the page after login so Echo connects with the user's client ID, or don't connect Echo for guests.

### Fixed

- Callbacks of `whisper`, `enter`, `update`, `leave` and `here` run exactly once; exceptions in callbacks and listeners no longer become unhandled promise rejections or stop other listeners.
- One attach failure is reported to `error()` once; subscribe errors that no channel state change reported still reach `error()`.
- Auth endpoint: cookies are sent cross-origin only for a lowercase `authorization` header, as with ably 1.x and 2.x; error codes come from the HTTP status; invalid tokens are rejected with code 50000 and no longer replace the cached token; a `requestTokenFn` that never settles no longer blocks other token requests forever (each request is bounded by 30 s, or `httpRequestTimeout` + 1 s if longer); `httpRequestTimeout` applies to auth requests.
- `environment`, `realtimeHost` and `restHost` are mapped to `endpoint` with a warning instead of being ignored.
- The CDN global `AblyPubSub` is detected, and a stale `ably` global gives a clear error.
- `import { Channel } from '@ably/laravel-echo'` works again.
- Attach and presence edge cases: concurrent attaches during authorization (a caller that awaits its attach is rejected when the authorization or the ATTACH fails), leaving a channel while it authorizes, `stopListening` / `stopListeningToAll` bookkeeping (`stopListeningToAll()` no longer removes `listen()` listeners), `listenToAll` with `namespace: false`, no duplicate presence enter after a resumed reconnect, and a re-enter when the last `enter()` failed.
- Channels subscribed before a failed connection are re-attached when it recovers, for example after login.
- The pre-attach authorize hook is per client: each Echo instance uses its own authorizer, and clients Echo doesn't create use ably's attach unchanged.
- Echo-only options (auth headers, bearer and CSRF tokens) are no longer passed into the Ably client options.
- Socket IDs and tokens with non-Latin-1 client IDs work in browsers.
- `private()`, `join()` and `leaveChannel()` work with `options.client`; `encryptedPrivate()` throws a clear error with the Ably broadcaster; relative auth endpoints resolve against the page URL; cached-token capabilities are matched by channel name.
- Calling `Echo.connect()` (or the connector's `connect()`) again leaves the existing Echo channels and closes the previous Ably client (a user-supplied `options.client` is not closed); callers re-subscribe after `connect()` is called again.
- A connection that fails for a reason other than a client ID change (40102) logs one `console.error` hint that MAU-billed accounts require a client ID for device connections.

### Known issues

- Access to private and presence channels can be lost briefly when the connection token is renewed after it expires: laravel-broadcaster keeps a token's channel capabilities only while that token is unexpired, so the renewed token has only the `public:*` capability, private and presence channels fail with 40160 and are re-authorized, and messages broadcast in that gap are lost. This needs a laravel-broadcaster fix; the sandbox test for it is skipped until then.

### Internal changes

- Internal behaviour changes inherited from ably-js v3 (error shapes, MsgPack in browsers, subscribe-capability errors, asynchronous callbacks); see the ably-js v3 migration guide: https://github.com/ably/ably-js/blob/main/docs/migration-guides/v3/lib.md. Pull requests: https://github.com/ably-forks/laravel-echo/pull/50, https://github.com/ably-forks/laravel-echo/pull/51, https://github.com/ably-forks/laravel-echo/pull/52, https://github.com/ably-forks/laravel-echo/pull/53.
- CI runs the Ably tests against both the Node and the browser build of `@ably/pubsub-device`; the browser-build job is blocking.

### Release

- 2.0.0 is published with the `next` dist-tag first (`npm publish --tag next`); install it with `npm install @ably/laravel-echo@next` during the beta period. `latest` stays 1.0.6 until 2.0.0 is promoted with `npm dist-tag add @ably/laravel-echo@2.0.0 latest`, without a second version bump.
- Rollback: `npm install @ably/laravel-echo@1.0.6 ably@1`.

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
