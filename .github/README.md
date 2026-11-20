## Introduction
This repository is a fork of https://github.com/laravel/echo. It adheres to public interface methods from base repository. It will be synced regularly with the base repository to make sure all the code is up to date.
Ably-specific implementation is added to support native [ably-js](https://github.com/ably/ably-js) via the [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) package.

> **Upgrading from 1.0.x?** See [UPDATING.md](https://github.com/ably-forks/laravel-echo/blob/HEAD/UPDATING.md#10x--11).

## Requirements
1. Node.js version >= 22 to install and build, required by `@ably/pubsub-device` v3 (browsers are unaffected)

## Installation 
 Install `@ably/laravel-echo` using npm. It depends directly on Ably's [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) v3, which npm installs with it, so you don't need to install `ably` or `@ably/pubsub-device` yourself.

```bash
npm install @ably/laravel-echo@^1.1
```

Once Echo is installed, you are ready to create a fresh Echo instance in your application's JavaScript. A great place to do this is at the bottom of the `resources/js/bootstrap.js` file that is included with the Laravel framework. By default, an example Echo configuration is already included in this file; however, the default configuration in the `bootstrap.js` file is intended for Pusher. You may copy the configuration below to transition your configuration to Ably.

```js
import Echo from '@ably/laravel-echo';

window.Echo = new Echo({
    broadcaster: 'ably',
});

window.Echo.connector.ably.connection.on(stateChange => {
    if (stateChange.current === 'connected') {
        console.log('connected to ably server');
    }
});
```

- Take a look at [laravel broadcasting auth-endpoint doc](https://laravel.com/docs/broadcasting#customizing-the-authorization-endpoint) for customizing authEndpoint.
```
    broadcaster: 'ably',
    authEndpoint: '/broadcasting/auth' // relative or absolute url to laravel-server
```

- You can set additional ably-js [js-clientOptions](https://ably.com/docs/api/realtime-sdk?lang=javascript#client-options) when creating an `Echo` instance. Some of those are =>

```
    broadcaster: 'ably',
    // ably specific client-options
    echoMessages: true, // self-echo for published message is set to false internally.
    queueMessages: true, // default: true, maintains queue for messages to be sent.
    disconnectedRetryTimeout: 15000, // reconnect after 15 seconds when client goes disconnected state
    suspendedRetryTimeout: 30000, // reconnect after 30 seconds when client goes suspended state
```
- [Auth specific clientOptions](https://sdk.ably.com/builds/ably/specification/main/features/#AO1) should not be used, since laravel `authEndpoint` is already responsible for token authentication and external auth mechanism is not needed.

Once you have uncommented and adjusted the Echo configuration according to your needs, you may compile your application's assets:

```shell
npm run dev
```
- Echo 1.1 handles login and user switches without a page reload, and recovers from a logout at the next token renewal. As part of logout, call `Echo.connect()` (then subscribe to your channels again) or `Echo.disconnect()`: otherwise the page keeps the old user's channel access until its token expires. See [UPDATING.md](https://github.com/ably-forks/laravel-echo/blob/HEAD/UPDATING.md#login-user-switch-and-logout-in-the-same-page) for login, user switches, other open tabs, your own Ably client and MAU-billed accounts.

## Guest users on MAU-billed Ably accounts
> **Note:** On MAU-billed Ably accounts, guests need a guest client ID from the broadcaster: use laravel-broadcaster 1.1 or later, set `ABLY_MAU_ACCOUNT=true`, and add `'mau_account' => env('ABLY_MAU_ACCOUNT', false)` to `config/broadcasting.php`. Without this, guest connections fail with error 40161.
> See [Guest users on MAU-billed Ably accounts in UPDATING.md](https://github.com/ably-forks/laravel-echo/blob/HEAD/UPDATING.md#guest-users-on-mau-billed-ably-accounts) for the config lines and options.

## Working with laravel sanctum/ support channel auth using custom implementation
- There is an explicit section for [Authorizing Private/Presence Broadcast Channels](https://laravel.com/docs/sanctum#authorizing-private-broadcast-channels).
- Equivalent of this is to provide `requestTokenFn` as an argument while creating an Echo instance
```js
    echo = new Echo({
            broadcaster: 'ably',
            tls: true,
            requestTokenFn: async (channelName: string, existingToken: string) => {
                let postData = { channel_name: channelName, token: existingToken };
                const res = await axios.post("/api/broadcasting/auth", postData);
                return res.data;
            },
    });
```
- Note: Do not add try/catch statement for above code, since exceptions are being handled internally.

##  Observing channel messages on ably dev-console and Leaving the channel
- You can get the internal channel name using
```
//public channel
let echoPublicChannel = Echo.channel('channel1');
let ablyPublicChannelName = echoPublicChannel.name;
console.log(ablyPublicChannelName); // public:channel1

// private channel
let echoPrivateChannel = Echo.private('channel2');
let ablyPrivateChannelName = echoPrivateChannel.name;
console.log(ablyPrivateChannelName); // private:channel2

// presence channel
let echoPresenceChannel = Echo.join('channel3');
let ablyPresenceChannelName = echoPresenceChannel.name;
console.log(ablyPresenceChannelName); // presence:channel3
```
- Use the same channel name for [observing channel messages on ably dev console](https://ably.com/docs/tools#developer-console).
- Use the same channel name for leaving the channel
```
Echo.leaveChannel(echoPublicChannel.name);
Echo.leaveChannel(echoPrivateChannel.name);
Echo.leaveChannel(echoPresenceChannel.name);
```

## Success/failure confirmation for whisper
- You can get acknowledgement for a whisper/client-event sent on a private/presence channel by passing an extra callback argument.
- Extra callback is a function that receives `err` object representing success/failure.
```
        echoPrivateChannel.subscribed(() => {
                echoPrivateChannel.whisper('msg', 'Hello there jonny!', (err) => {
                    if(err) {
                        console.log('whisper failed with error ' + err);
                    } else {
                        console.log('whisper succeeded');
                    }
                });
            });
```

## Official Documentation
- More documentation for Echo can be found on the [Laravel website](https://laravel.com/docs/broadcasting).

## Contributing
- Make sure all of the public interfacing methods on `Echo` and `Channel` object are kept intact irrespective of internal implementation.
- Follow the below steps for modifying the code.
1. Fork it.
2. Create your feature branch (`git checkout -b my-new-feature`).
3. Commit your changes (`git commit -am 'Add some feature'`).
4. Ensure you have added suitable tests and the test suite is passing (run `npm test`)
4. Push to the branch (`git push origin my-new-feature`).
5. Create a new Pull Request.


## Release Process
This library uses [semantic versioning](http://semver.org/). In the steps below, `<version>` is the version being released (e.g. `1.1.1`), the git tag is `ably-echo-<version>`, and `<previous-version>` is the last release. Releases are manual. Steps 1 to 7 run in your normal checkout of this repo; steps 8 to 12 run in a **separate fresh clone**.

**Why steps 8 to 12 look like this:** An earlier release shipped with a stale `dist/` and the upstream README. `dist/` is git-ignored, so publishing from a working copy packs whatever old build is lying around, and `prepublishOnly` (the build and README swap) is skipped when npm runs with `ignore-scripts=true`. So: publish only from a fresh clone, build explicitly, and publish only the `.tgz` that `scripts/verify-package.mjs` has passed.

1. Create a new branch for the release, named like `release/<version>`.
2. Update the version in `package.json` and `package-lock.json`: `npm version <version> --no-git-tag-version`.
3. Run [`github_changelog_generator`](https://github.com/github-changelog-generator/github-changelog-generator) to automate the update of the [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md). This may require some manual intervention, both in terms of how the command is run and how the change log file is modified. Your mileage may vary:
    - The command you will need to run will look something like this: `github_changelog_generator -u ably-forks -p laravel-echo --since-tag ably-echo-<previous-version> --output delta.md --token $GITHUB_TOKEN_WITH_REPO_ACCESS`. Generate token [here](https://github.com/settings/tokens/new?description=GitHub%20Changelog%20Generator%20token).
    - Using the command above, `--output delta.md` writes changes made after `--since-tag` to a new file.
    - The contents of that new file (`delta.md`) then need to be manually inserted at the top of the [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md), changing the "Unreleased" heading and linking with the current version numbers.
    - Also ensure that the "Full Changelog" link points to the new version tag instead of the `HEAD`.
4. Commit the version bump and the generated [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md) file at root.
5. Make a PR against `master`.
6. Once the PR is approved, merge it into `master`.
7. Tag the merge commit and push the tag: `git checkout master && git pull && git tag ably-echo-<version> && git push origin ably-echo-<version>`.
8. In an empty directory outside your checkout, make a fresh clone at the tag: `git clone --branch ably-echo-<version> https://github.com/ably-forks/laravel-echo.git echo-release && cd echo-release`.
9. Install and build explicitly (do not rely on `prepublishOnly`): `npm ci && npm run build && npm run use:ablyReadme`. The last command swaps in this Ably `README.md` for the upstream Laravel one.
10. Pack and verify:
    - `npm pack --ignore-scripts` creates `ably-laravel-echo-<version>.tgz`.
    - `node scripts/verify-package.mjs ably-laravel-echo-<version>.tgz <version>` checks that the tarball has the built bundles for this version, `@ably/pubsub-device`, no global `Ably`, and the Ably README.
    - **Gate: do not publish unless it prints `All checks passed.`** If it fails, go back to step 9 in a clean clone.
11. Publish the verified tarball (never the folder):
    - `npm whoami` must show your npm account (run `npm login` if not; have your 2FA code ready).
    - Rehearse with `npm publish ably-laravel-echo-<version>.tgz --dry-run`, then publish with `npm publish ably-laravel-echo-<version>.tgz`.
    - Publishing sets the `latest` dist-tag. Check it with `npm dist-tag ls @ably/laravel-echo`.
12. Smoke-check the published package:
    - `npm view @ably/laravel-echo@<version> dist.unpackedSize gitHead` shows the same `unpacked size` that `npm pack` printed in step 10, and the tagged commit.
    - In an empty temp directory, run `npm install @ably/laravel-echo@<version>` and construct `new Echo({ broadcaster: 'ably', authEndpoint: 'http://127.0.0.1:9/auth' })`. It must not throw `ReferenceError: Ably is not defined`.
13. Visit https://github.com/ably-forks/laravel-echo/tags and add release notes to the release (generally you can just copy the notes you added to the CHANGELOG).
14. Update the [Ably Changelog](https://changelog.ably.com/) (via [headwayapp](https://headwayapp.co/)) with these changes (again, you can just copy the notes you added to the CHANGELOG).

If a bad version is published:
  - Point `latest` back at the last good version: `npm dist-tag add @ably/laravel-echo@<previous-version> latest`.
  - Warn users: `npm deprecate @ably/laravel-echo@<bad-version> "<what is wrong and which version to use>"`.
  - Release a fixed patch with the steps above (a version number cannot be re-published).
  - Avoid `npm unpublish`: it breaks users who already depend on that version.

## Note 
- Current `README` is newly created and located under `.github/README.md`.
- `CHANGELOG-ABLY.md` will be used for commiting changelog instead of `CHANGELOG.md`.
- This is mainly to avoid syncing conflicts with base repository.
