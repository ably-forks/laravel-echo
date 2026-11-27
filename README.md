# Laravel Echo for Ably

This repository is Ably's fork of [Laravel Echo](https://github.com/laravel/echo). It keeps upstream's public API and adds a native Ably connector, built on Ably's [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) SDK. The `2.x` line is synced with upstream `laravel/echo` 2.x.

On the server, use [`ably/laravel-broadcaster`](https://github.com/ably/laravel-broadcaster) 2.x. Echo 2.x works only with laravel-broadcaster 2.x, so upgrade both together.

## Packages

| Package                     | npm                                                            | Documentation                                            |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `@ably/laravel-echo`        | [npm](https://www.npmjs.com/package/@ably/laravel-echo)        | [packages/laravel-echo](packages/laravel-echo/README.md) |
| `@ably/laravel-echo-react`  | [npm](https://www.npmjs.com/package/@ably/laravel-echo-react)  | [packages/react](packages/react/README.md)               |
| `@ably/laravel-echo-vue`    | [npm](https://www.npmjs.com/package/@ably/laravel-echo-vue)    | [packages/vue](packages/vue/README.md)                   |
| `@ably/laravel-echo-svelte` | [npm](https://www.npmjs.com/package/@ably/laravel-echo-svelte) | [packages/svelte](packages/svelte/README.md)             |

The React, Vue and Svelte packages use `@ably/laravel-echo` as a peer dependency, so install it next to them. All four packages share one version number.

## Documentation

- Setup, options and troubleshooting: the [`@ably/laravel-echo` README](packages/laravel-echo/README.md).
- Upgrading: [UPDATING.md](UPDATING.md).
- Release notes: [CHANGELOG-ABLY.md](CHANGELOG-ABLY.md).
- Ably: the [Ably documentation](https://ably.com/docs).
- Laravel broadcasting: the [Laravel documentation](https://laravel.com/docs/broadcasting).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a security vulnerability, see the [security policy](.github/SECURITY.md).

## License

Laravel Echo and this fork are open-source software licensed under the [MIT license](LICENSE.md).
