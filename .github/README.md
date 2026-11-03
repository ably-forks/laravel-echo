## Introduction
This repository is a fork of https://github.com/laravel/echo. It adheres to public interface methods from base repository. It will be synced regularly with the base repository to make sure all the code is up to date.
Ably-specific implementation is added to support native [ably-js](https://github.com/ably/ably-js).

## Installation 
 Install `@ably/laravel-echo` (wrapper for pluggable lib) and latest version of `ably` (pluggable lib) using npm.

```bash
npm install @ably/laravel-echo ably@2.x
```

Once Echo is installed, you are ready to create a fresh Echo instance in your application's JavaScript. A great place to do this is at the bottom of the `resources/js/bootstrap.js` file that is included with the Laravel framework. By default, an example Echo configuration is already included in this file; however, the default configuration in the `bootstrap.js` file is intended for Pusher. You may copy the configuration below to transition your configuration to Ably.

```js
import Echo from '@ably/laravel-echo';
import * as Ably from 'ably';

window.Ably = Ably; // make globally accessible to Echo
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
- If you are using SPA on client side, on user login, new clientId is assigned to the token. So, connection goes into failed state for next channel attach. We have fixed this issue. Now, it immediately reconnects again, reattaching all existing channels. See [Fix clientId mismatch](https://github.com/ably-forks/laravel-echo/pull/38) for more details. On user logout, connection+channels goes into failed state, and doesn't reconnect again. Hence, you need to create a new Echo instance after user logs out.

## Working with laravel sanctum/ support channel auth using custom implementation
- There is an explicit section for [Authorizing Private/Presence Broadcast Channels](https://laravel.com/docs/sanctum#authorizing-private-broadcast-channels).
- Equivalent of this is to provide `requestTokenFn` as an argument while creating an Echo instance
```js
    echo = new Echo({
            broadcaster: 'ably',
            useTls: true,
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
4. Ensure you have added suitable tests and the test suite is passing (run `vendor/bin/phpunit`)
4. Push to the branch (`git push origin my-new-feature`).
5. Create a new Pull Request.


## Release Process
This library uses [semantic versioning](http://semver.org/). For each release, the following needs to be done:

1. Create a new branch for the release, named like `release/1.0.3` (where `1.0.3` is what you're releasing, being the new version).
2. Update the `LIB_VERSION` in `src/connector/ably-connector.ts`.
3. Update `version` in `pakckage.json`.
4. Run [`github_changelog_generator`](https://github.com/github-changelog-generator/github-changelog-generator) to automate the update of the [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md). This may require some manual intervention, both in terms of how the command is run and how the change log file is modified. Your mileage may vary:
  - The command you will need to run will look something like this: `github_changelog_generator -u ably-forks -p laravel-echo --since-tag ably-echo-1.0.3 --output delta.md --token $GITHUB_TOKEN_WITH_REPO_ACCESS`. Generate token [here](https://github.com/settings/tokens/new?description=GitHub%20Changelog%20Generator%20token).
  - Using the command above, `--output delta.md` writes changes made after `--since-tag` to a new file.
  - The contents of that new file (`delta.md`) then need to be manually inserted at the top of the [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md), changing the "Unreleased" heading and linking with the current version numbers.
  - Also ensure that the "Full Changelog" link points to the new version tag instead of the `HEAD`.
5. Commit generated [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md) file at root.
6. Make a PR against `main`.
7. Once the PR is approved, merge it into `main`.
8. Add a tag and push it to origin - e.g.: `git tag ably-echo-1.0.3 && git push origin ably-echo-1.0.3`.
9. Publish npm package on npmjs.com.
10. Visit https://github.com/ably-forks/laravel-echo/tags and add release notes to the release (generally you can just copy the notes you added to the CHANGELOG).
11. Update the [Ably Changelog](https://changelog.ably.com/) (via [headwayapp](https://headwayapp.co/)) with these changes (again, you can just copy the notes you added to the CHANGELOG).

## Note 
- Current `README` is newly created and located under `.github/README.md`.
- `CHANGELOG-ABLY.md` will be used for commiting changelog instead of `CHANGELOG.md`.
- This is mainly to avoid syncing conflicts with base repository.
