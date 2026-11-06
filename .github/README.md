## Introduction
This repository is a fork of https://github.com/laravel/echo. It adheres to public interface methods from base repository. It will be synced regularly with the base repository to make sure all the code is up to date.
Ably-specific implementation is added to support native [ably-js](https://github.com/ably/ably-js) via the [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) package.

## Installation 
 Install `@ably/laravel-echo` using npm. It installs its own copy of Ably's [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) v3.

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

- Echo uses its own `@ably/pubsub-device` and ignores a global `Ably` or `AblyPubSub`. If your `bootstrap.js` still has `import * as Ably from 'ably'; window.Ably = Ably;` (or `window.Ably = require('ably')`), remove it. It is harmless if left, but Echo logs a one-time `console.warn` while it is there.
- **Script tag:** `dist/echo.iife.js` includes `@ably/pubsub-device`, so it needs no separate Ably script.

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
- **Login and user switch in a single-page app.** An Ably connection cannot change its client ID, so when a user logs in, or another user logs in, the next private or presence channel request returns a token for the new client ID and Echo reconnects with it and re-attaches all existing channels (see [Fix clientId mismatch](https://github.com/ably-forks/laravel-echo/pull/38)). This also works for a second switch in the same page. The transient "mismatched clientId" error (40102) of such a switch is not reported to `error()`.
- **After logout, call `Echo.connect()` or create a new Echo instance.** Echo closes the old connection and connects as a guest; subscribe to your channels again. Private and presence channels are then denied by your broadcaster, as for any guest. On MAU-billed Ably accounts, guests need a client ID: see "Guest users on MAU-billed Ably accounts" below.
- **Logout or login in another tab.** Other open tabs switch to the new identity (a guest, no client ID, or another user) at their next connection token renewal, so after up to the token lifetime (laravel-broadcaster's `token_expiry`, 8 hours by default). They reconnect once as the new identity (typically within a second or two) and re-attach their channels. When Ably asks a connected page to re-authenticate (with long-lived tokens, shortly before they expire), the connection briefly reports `failed` (40102, not passed to `error()`) before it reconnects. Private and presence channels are authorized again, as after an in-page switch: after a login they attach without any `error()` call, and after a logout `error()` receives the broadcaster's denial (403) once. On MAU-billed accounts without guest client IDs, a switch to no client ID fails with 40161 (see "Guest users on MAU-billed Ably accounts"). To switch every tab at once, tell the other tabs to call `Echo.connect()`, for example with a [`BroadcastChannel`](https://developer.mozilla.org/docs/Web/API/BroadcastChannel):
```js
const authTabs = new BroadcastChannel('auth');
authTabs.onmessage = () => window.Echo.connect(); // then subscribe to your channels again

// in the tab that logged in or out, once the request has succeeded:
authTabs.postMessage('identity-changed');
window.Echo.connect();
```

## Upgrading to 1.1

`@ably/laravel-echo` 1.1 uses Ably's [`@ably/pubsub-device`](https://www.npmjs.com/package/@ably/pubsub-device) package instead of `ably`, and installs it itself. The Echo API (`channel`, `private`, `join`, `listen`, `whisper`, `here`, `error`, `socketId`, …) is unchanged.

1. **Install.** `npm install @ably/laravel-echo@^1.1`. You no longer install or expose an Ably library for Echo: remove `import * as Ably from 'ably'; window.Ably = Ably;` (or `window.Ably = require('ably')`) and the `ably` dependency if nothing else uses them. Echo ignores a global `Ably`/`AblyPubSub` and logs a one-time `console.warn` while one exists. A client you pass as `options.client` is still used as is. Apps that use this package only with Pusher, Reverb or socket.io now also install `@ably/pubsub-device` and include it in their bundle (about 100 KB gzipped); they should use upstream `laravel-echo`.
2. **Script tag.** `dist/echo.iife.js` bundles `@ably/pubsub-device`; remove the Ably CDN script unless your own code uses it.
3. **Node.js 22 or later** is needed to install and build (it affects build machines and CI, not browsers).
4. **Guest users on MAU-billed Ably accounts.** Every device connection must carry a client ID, so a guest connection without one is rejected with error 40161. Set `ABLY_MAU_ACCOUNT=true` (config `broadcasting.connections.ably.mau_account`) in laravel-broadcaster 1.1.0 or later, so guests get a broadcaster-issued guest client ID; in-page login, user switch and logout then work as described above. Otherwise, only connect Echo for signed-in users. Each guest session counts as a monthly active user. Echo logs a hint to the console for the MAU error codes: 40161 (a guest without a client ID), 40168 (an incompatible or older Ably SDK build) and 40167 (a server-side client without the server claim; server-side tokens only).
5. **Using `echo.connector.ably` directly, or passing Ably client options through Echo** (for example `environment`, now `endpoint`)? See [Getting started with Ably in JavaScript](https://ably.com/docs/getting-started/javascript) and the [ably-js v3 migration guide](https://github.com/ably/ably-js/blob/main/docs/migration-guides/v3/lib.md).

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
This library uses [semantic versioning](http://semver.org/). For each release, the following needs to be done:

1. Create a new branch for the release, named like `release/1.0.3` (where `1.0.3` is what you're releasing, being the new version).
2. Update `version` in `package.json`.
3. Run [`github_changelog_generator`](https://github.com/github-changelog-generator/github-changelog-generator) to automate the update of the [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md). This may require some manual intervention, both in terms of how the command is run and how the change log file is modified. Your mileage may vary:
  - The command you will need to run will look something like this: `github_changelog_generator -u ably-forks -p laravel-echo --since-tag ably-echo-1.0.3 --output delta.md --token $GITHUB_TOKEN_WITH_REPO_ACCESS`. Generate token [here](https://github.com/settings/tokens/new?description=GitHub%20Changelog%20Generator%20token).
  - Using the command above, `--output delta.md` writes changes made after `--since-tag` to a new file.
  - The contents of that new file (`delta.md`) then need to be manually inserted at the top of the [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md), changing the "Unreleased" heading and linking with the current version numbers.
  - Also ensure that the "Full Changelog" link points to the new version tag instead of the `HEAD`.
4. Commit generated [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md) file at root.
5. Make a PR against `master`.
6. Once the PR is approved, merge it into `master`.
7. Add a tag and push it to origin - e.g.: `git tag ably-echo-1.0.3 && git push origin ably-echo-1.0.3`.
8. Publish npm package on npmjs.com.
9. Visit https://github.com/ably-forks/laravel-echo/tags and add release notes to the release (generally you can just copy the notes you added to the CHANGELOG).
10. Update the [Ably Changelog](https://changelog.ably.com/) (via [headwayapp](https://headwayapp.co/)) with these changes (again, you can just copy the notes you added to the CHANGELOG).

## Note 
- Current `README` is newly created and located under `.github/README.md`.
- `CHANGELOG-ABLY.md` will be used for commiting changelog instead of `CHANGELOG.md`.
- This is mainly to avoid syncing conflicts with base repository.
