# Changelog

## Unreleased

### Breaking changes

- Updated the Ably dependency range to `ably@^2.0`; `ably@1.x` is no longer supported.
- Consumers using Ably APIs directly through `echo.connector.ably` must use Ably v2 promise APIs instead of v1 callback APIs, for example `await echo.connector.ably.time()` instead of `echo.connector.ably.time(callback)`.
- Removed compatibility with the Ably v1 `ably/promises` entry point; import from `ably` instead.

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
