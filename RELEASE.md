# Release Instructions

This library uses [semantic versioning](http://semver.org/). Below, `<version>` is the version being released (e.g. `1.1.1`) and the git tag is `ably-echo-<version>`. Releases are published manually.

**Why:** a stale git-ignored `dist/` and the upstream README were once published, because `prepublishOnly` is skipped under `ignore-scripts=true`. So `npm run release:pack` does a clean build and checks the package, and you only publish the file it creates.

1. Create a new branch for the release, named like `release/<version>`.
2. Set the version in `package.json` and `package-lock.json`: `npm version <version> --no-git-tag-version`.
3. Run [`github_changelog_generator`](https://github.com/github-changelog-generator/github-changelog-generator) to automate the update of the [CHANGELOG-ABLY.md](CHANGELOG-ABLY.md). This may require some manual intervention, both in terms of how the command is run and how the change log file is modified. Your mileage may vary:
    - The command you will need to run will look something like this: `github_changelog_generator -u ably-forks -p laravel-echo --since-tag ably-echo-<previous-version> --output delta.md --token $GITHUB_TOKEN_WITH_REPO_ACCESS`. Generate token [here](https://github.com/settings/tokens/new?description=GitHub%20Changelog%20Generator%20token).
    - Using the command above, `--output delta.md` writes changes made after `--since-tag` to a new file.
    - The contents of that new file (`delta.md`) then need to be manually inserted at the top of the [CHANGELOG-ABLY.md](CHANGELOG-ABLY.md), changing the "Unreleased" heading and linking with the current version numbers.
    - Also ensure that the "Full Changelog" link points to the new version tag instead of the `HEAD`.
4. Commit the version bump and [CHANGELOG-ABLY.md](CHANGELOG-ABLY.md), and make a PR against `master`.
5. Once the PR is approved, merge it into `master`.
6. Update your local `master` and tag it, then push the tag: `git checkout master && git pull origin master && git tag ably-echo-<version> && git push origin ably-echo-<version>`.
7. `release:pack` packs the current checkout, so commit or stash any local changes, then check out the release tag: `git checkout ably-echo-<version>`. `git describe --tags --exact-match` must print `ably-echo-<version>` (it errors otherwise). Then run `npm run release:pack -- <version>`. It refuses to run if `package.json` is not that version, and creates `ably-laravel-echo-<version>.tgz` only if its sanity checks pass, printing the tarball's integrity.
8. Publish that tarball, never a folder: `npm whoami` (log in first if it fails), then `npm publish ably-laravel-echo-<version>.tgz`. Check `npm view @ably/laravel-echo@<version> dist.integrity` against the integrity that `release:pack` printed.
9. Visit https://github.com/ably-forks/laravel-echo/tags and add release notes to the release (generally you can just copy the notes you added to the CHANGELOG), and update the [Ably Changelog](https://changelog.ably.com/) (via [headwayapp](https://headwayapp.co/)) with the same notes.
