# Release Instructions

> **Status:** this is the planned 2.x release process. The release tooling it describes (`release.sh` for this fork, the `publish.yml` workflow and the tarball checks) is being set up for the first 2.0.0 release candidate. Check each step against those files, and update this document with what was actually done.

This repository publishes four packages with one shared version (lockstep), using [semantic versioning](http://semver.org/):

- `@ably/laravel-echo`
- `@ably/laravel-echo-react`
- `@ably/laravel-echo-vue`
- `@ably/laravel-echo-svelte`

Releases of the 2.x line are made from the `2.x` branch. One git tag, `ably-echo-<version>` (for example `ably-echo-2.0.0`), covers all four packages. Below, `<version>` is the version being released.

## Rules

- **Publish from CI only.** The `publish.yml` workflow publishes the packages with npm trusted publishing (OIDC) and provenance. There is no npm token.
- **Never rely on `prepublish*` or `postpublish` scripts.** Setups with `ignore-scripts=true` skip them; this is how a stale `dist/` and the wrong README were once published. CI builds explicitly, checks each tarball, and publishes exactly the tarballs it checked.
- **Release together with laravel-broadcaster.** Echo 2.x works only with laravel-broadcaster 2.x. Release on the same day as the matching laravel-broadcaster release: Echo may go first, **never laravel-broadcaster first**.
- **Every push, tag, GitHub release and npm action needs the maintainers' explicit go-ahead.**

## Steps

1. **Prepare the changelog.** Add the release's entry to the top of [CHANGELOG-ABLY.md](CHANGELOG-ABLY.md), with a "Full Changelog" link that compares the previous tag with the new one. [`github_changelog_generator`](https://github.com/github-changelog-generator/github-changelog-generator) can help: `github_changelog_generator -u ably-forks -p laravel-echo --since-tag ably-echo-<previous-version> --output delta.md --token <token>` writes the changes since the previous tag to `delta.md`; edit them into the entry by hand.
2. **Bump the version** with `./release.sh <version>` on an up-to-date `2.x`. It:
    - sets `<version>` in all four `package.json` files;
    - sets the React, Vue and Svelte packages' peer dependency on `@ably/laravel-echo`: `^2.0.0-rc.0` for a release candidate, `^2.0.0` for a final release;
    - updates the lockfile (`pnpm install`);
    - commits `Release <version>` and tags `ably-echo-<version>`;
    - pushes the commit and the tag, and creates the GitHub release from the changelog entry (a prerelease for a release candidate).
3. **CI publishes.** The GitHub release starts `publish.yml`:
    - a `verify` job builds, tests and audits, packs the four packages and checks each tarball (built `dist` files with `.cjs` CommonJS entries, `@ably/pubsub-device` external in the ESM and CommonJS builds and bundled in the core IIFE, the embedded version, the Ably README, no `workspace:` ranges, the adapters' peer range, `repository.url`);
    - a `publish` job then publishes the four checked tarballs one at a time, the core first, under the npm dist-tag `next` for a prerelease and `latest` otherwise.
4. **If a publish leg fails** after the core was published, don't unpublish. Fix the cause and re-run only the failed legs. Keep the GitHub release marked as a prerelease (or draft) until all four packages have the same version.
5. **Check npm:** `npm view @ably/laravel-echo dist-tags`, and the same for the other three packages.
6. **Announce:** update the [Ably Changelog](https://changelog.ably.com/) (via [headwayapp](https://headwayapp.co/)) with the release notes.

## Release candidates and 2.0.0

- Publish `2.0.0-rc.N` first, under the dist-tag `next`, and test it with a laravel-broadcaster 2.x build before publishing `2.0.0` under `latest`.
- At the 2.0.0 release, make `2.x` the repository's default branch on GitHub.
- The first publish of `@ably/laravel-echo-react`, `-vue` and `-svelte` may need an npm owner, if npm cannot configure a trusted publisher for a package that does not exist yet. In that case an npm owner publishes `2.0.0-rc.0` of those packages once by hand, from the tarballs that CI built, and then configures the trusted publisher.

## 1.x maintenance releases

1.x releases (`@ably/laravel-echo` 1.x only) are made from the `master` branch, following the release process documented there. They are published under the npm dist-tag `latest-1`, so that they don't replace 2.x as `latest`, and their GitHub releases are not marked as the latest release.
