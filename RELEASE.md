# Release Instructions

> **Status:** the release tooling described here (`release.sh`, the `publish.yml` workflow and `scripts/check-release-tarballs.mjs`) is in place, but no 2.x release has been made with it yet. Steps marked **[first RC]** are confirmed only when `2.0.0-rc.0` is released; update this document with what actually happened.

This repository publishes four packages with one shared version (lockstep), using [semantic versioning](http://semver.org/):

- `@ably/laravel-echo`
- `@ably/laravel-echo-react`
- `@ably/laravel-echo-vue`
- `@ably/laravel-echo-svelte`

Releases of the 2.x line are made from the `2.x` branch. One git tag, `ably-echo-<version>` (for example `ably-echo-2.0.0`), covers all four packages. Below, `<version>` is the version being released: `X.Y.Z`, or `X.Y.Z-rc.N` for a release candidate.

## Rules

- **Publish from CI only.** The `publish.yml` workflow publishes the packages with npm trusted publishing (OIDC) and provenance. There is no npm token.
- **Never rely on `prepublish*` or `postpublish` scripts.** Setups with `ignore-scripts=true` skip them; this is how a stale `dist/` and the wrong README were once published. CI builds explicitly, checks each tarball, and publishes exactly the tarballs it checked.
- **Release together with laravel-broadcaster.** Echo 2.x works only with laravel-broadcaster 2.x. Release on the same day as the matching laravel-broadcaster release: Echo may go first, **never laravel-broadcaster first**.
- **Every step marked [GATE] needs the maintainers' explicit go-ahead:** every push, tag, GitHub release and npm action.

## One-time setup: npm trusted publishers [GATE]

An npm owner of each package configures a trusted publisher on npmjs.com (package settings → Trusted publisher → GitHub Actions):

- repository: `ably-forks/laravel-echo`;
- workflow: `publish.yml`;
- environment: none.

`@ably/laravel-echo` already exists, so it can be configured before the first release. For `@ably/laravel-echo-react`, `-vue` and `-svelte`, which don't exist on npm yet:

1. If npm lets you configure a trusted publisher for a package that has not been published yet, configure it as above.
2. Otherwise, the first `publish.yml` run publishes the core and fails for the three new packages. An npm owner then publishes `2.0.0-rc.0` of those three once by hand, **from the tarballs CI checked**:
    1. download them: `gh run download <run-id> --repo ably-forks/laravel-echo --name release-tarballs`;
    2. compare each file's `sha512` with the one the `verify` job printed;
    3. publish each one with 2FA: `npm publish <tarball> --access public --tag next`;
    4. configure the trusted publisher for each package as above;
    5. re-run the failed jobs of the workflow run (`gh run rerun <run-id> --failed`); they skip the versions that are already on npm.

    All later versions go through `publish.yml`.

Optionally, after the first publish through OIDC, set each package to "Require two-factor authentication and disallow tokens".

## Steps

1. **Prepare the changelog.** Add the release's entry to the top of [CHANGELOG-ABLY.md](CHANGELOG-ABLY.md), headed `## [v<version>](https://github.com/ably-forks/laravel-echo/tree/ably-echo-<version>)`, with a "Full Changelog" link that compares the previous tag with the new one. [`github_changelog_generator`](https://github.com/github-changelog-generator/github-changelog-generator) can help: `github_changelog_generator -u ably-forks -p laravel-echo --since-tag ably-echo-<previous-version> --output delta.md --token <token>` writes the changes since the previous tag to `delta.md`; edit them into the entry by hand. A release candidate without an entry of its own uses the entry of the version it is a candidate for, without its "Full Changelog" link. Merge the changelog into `2.x` by pull request.
2. **Dry run.** On an up-to-date, clean `2.x`, with pnpm 12.3.4 (the `packageManager` version; see [CONTRIBUTING.md](CONTRIBUTING.md)) and Node.js 22 or later:

    ```bash
    DRY_RUN=1 ./release.sh <version>
    ```

    It runs every local step of the release below, prints the commands it would run to commit, tag, push and release, and then restores the changed files. Nothing leaves the machine. `dist/` and `release-tarballs/` (both git-ignored) are left with the `<version>` build.

3. **Release [GATE].** `./release.sh <version>`. It:
    - checks that you are on `2.x` with a clean working tree, pulls `2.x`, and checks that the four packages share one version, that pnpm is the `packageManager` version, and that neither the tag nor `<version>` of any package exists yet (on origin and on npm);
    - writes the GitHub release notes from the changelog entry;
    - sets `<version>` in all four `package.json` files (`pnpm -r --filter './packages/*' exec pnpm version <version> --no-git-tag-version`);
    - sets the React, Vue and Svelte packages' peer dependency on `@ably/laravel-echo` (see "Adapter peer range" below) and checks it;
    - updates the lockfile (`pnpm install`);
    - builds (`pnpm build`) and checks the tarballs (`node scripts/check-release-tarballs.mjs`), as CI will;
    - asks you to type `<version>` again, then commits `Release <version>`, tags `ably-echo-<version>`, pushes `2.x` and the tag, and creates the GitHub release titled `v<version>` for the tag `ably-echo-<version>`, with the changelog entry as its notes: a prerelease for `X.Y.Z-rc.N`, marked as the latest release otherwise.

    If it stops before the commit, it restores the files it changed.

4. **CI publishes.** Publishing the GitHub release starts `publish.yml`:
    - the `verify` job first runs the release guard (`scripts/release-guard.sh`): the tag must be `ably-echo-<version>`, all four packages must be at `<version>`, and the GitHub release's prerelease flag must match the version (`X.Y.Z-rc.N`: a prerelease, published under `next`; `X.Y.Z`: not a prerelease, published under `latest`). Anything else fails before anything is packed or published. It then installs with the frozen lockfile, builds, runs the tests, the bundle smoke tests, `pnpm audit` and the release helper tests (`bash scripts/test-release-lib.sh`), then packs the four packages into `release-tarballs/` and checks each tarball with `scripts/check-release-tarballs.mjs`, and uploads the four tarballs as the `release-tarballs` artifact. The tarball check asserts:
        - the version equals the tag's version, and the GitHub release's prerelease flag matches it;
        - every file named by `main`, `module`, `types`, `svelte` and `exports` is in the tarball (core `dist/echo.js`, `dist/echo.common.cjs`, `dist/echo.iife.js`, `dist/echo.d.ts`; the adapters' `dist/index.js`, `dist/index.common.cjs` and IIFE, and React's `dist/index.common.js`);
        - the tarball holds only `dist/`, `package.json`, the README and the license: no tests, no `resources/boost`, no stray `dist/src` or `dist/tests`;
        - `repository.url` is `https://github.com/ably-forks/laravel-echo` (trusted publishing and provenance need it), `publishConfig` is public with provenance, there are no `workspace:` or `catalog:` ranges and no publish or install lifecycle scripts;
        - core: the ESM and CommonJS builds import `@ably/pubsub-device` (not bundled), the IIFE bundles it, all three embed the version, and the README is the Ably one;
        - adapters: the ESM and CommonJS builds import `@ably/laravel-echo`, the IIFE uses the global `Echo`, neither the Ably SDK nor the core is bundled, the peer range is right for the release type, and the README names the package;
        - each tarball glob in the `publish` matrix matches exactly its own tarball.
    - the `publish` job then publishes the four checked tarballs one at a time (`max-parallel: 1`), the core first, with npm 11.5.1 or later: `npm publish <tarball> --access public --provenance --tag <next|latest>`, with the dist-tag the release guard derived from the version. A version that is already on npm is skipped. It runs only for a GitHub release of `ably-forks/laravel-echo` whose tag starts with `ably-echo-`.
5. **If a publish leg fails** after the core was published, don't unpublish. Fix the cause and re-run only the failed jobs: `gh run rerun <run-id> --repo ably-forks/laravel-echo --failed` [GATE]. Lockstep is restored once all four packages have the same version. Until then, keep the GitHub release marked as a prerelease.
6. **Check npm:** `npm view <package> dist-tags` for each of the four packages, and that each version shows provenance. `npm view <package>@<version> dist.integrity` matches the `sha512` the `verify` job printed.
7. **Announce** a final release: update the [Ably Changelog](https://changelog.ably.com/) (via [headwayapp](https://headwayapp.co/)) with the release notes.

A manual run of `publish.yml` (Actions → publish → Run workflow, on a branch) runs only the `verify` job, without the release guard, and never publishes. `bash scripts/test-release-lib.sh` tests the release helpers, the release guard and the workflow's job conditions (`scripts/test-publish-workflow.mjs`). To check the tarballs locally on a release commit: `pnpm build && node scripts/check-release-tarballs.mjs`. Between releases the manifests may not match a release (the adapters keep an RC peer range until the final release), so use the dry run instead.

## Adapter peer range

The React, Vue and Svelte packages declare `@ably/laravel-echo` as a peer dependency, so an app has one copy of the core. `release.sh` sets it from the release version (`adapter_peer_range` in `scripts/release-lib.sh`; `scripts/check-release-tarballs.mjs` checks the same rule):

| Release                        | Example          | Peer range                                                                                                      |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Release candidate `X.Y.Z-rc.N` | `2.0.0-rc.1`     | `^X.Y.Z-rc.0`, for example `^2.0.0-rc.0`: every release candidate of `X.Y.Z`, `X.Y.Z` itself and later releases |
| Release `X.Y.Z`                | `2.0.0`, `2.1.0` | `^X.Y.Z`, for example `^2.0.0`, `^2.1.0`: at least the core the adapter was released with                       |

A release adapter never admits a release candidate of the core, which it was not released against. This is specific to this fork: upstream's framework packages bundle the core instead of declaring it as a peer.

## Release candidates and 2.0.0

1. `./release.sh 2.0.0-rc.0` on `2.x`: a GitHub prerelease, published under the npm dist-tag `next` [GATE].
2. Test it with a laravel-broadcaster 2.x build: the sandbox suites in CI, the laravel-broadcaster end-to-end run against the real PHP broadcaster, and a small app with each framework package (`npm install @ably/laravel-echo@next @ably/laravel-echo-react@next`, and so on).
3. Fix, then `2.0.0-rc.1`, and so on.
4. For 2.0.0:
    1. make `2.x` the repository's default branch on GitHub [GATE]; `master` stays the 1.x line;
    2. `./release.sh 2.0.0`, which sets the adapters' peer range to `^2.0.0` [GATE];
    3. CI publishes all four packages under `latest`;
    4. check that `npm view @ably/laravel-echo dist-tags` shows `latest: 2.0.0`, and that `latest-1` still points at the newest 1.x release;
    5. once `2.x` is the default branch, check that Dependabot's first runs (GitHub Actions and npm) succeed.

**[first RC]** Confirm on `2.0.0-rc.0`, and record the outcome here:

- the version bump command, `pnpm -r --filter './packages/*' exec pnpm version <version> --no-git-tag-version`, under pnpm 12.3.4 on the release machine;
- the publish order (core first, one package at a time);
- the runner's npm version (11.5.1 or later), and that `npm publish <tarball> --provenance` with OIDC publishes with provenance. If npm rejects provenance for a tarball argument, publish from the package directory after `pnpm pack`, and compare checksums;
- the trusted publisher setup for the three new packages (above).

## If something goes wrong

- **A published version cannot be overwritten.** Fix it with a new version (`-rc.N+1`, or a patch release).
- **A broken `latest`:** point `latest` back at the last good version, for example `npm dist-tag add @ably/laravel-echo@<good-version> latest` [GATE], then publish a fix.
- **OIDC misconfiguration** shows up as a failed `publish` job; fix the trusted publisher settings and re-run the failed jobs.

## 1.x maintenance releases

1.x releases (`@ably/laravel-echo` 1.x only) are made from the `master` branch, following the release process documented there. They are published under the npm dist-tag `latest-1`, so that they don't replace 2.x as `latest`, and their GitHub releases are created with `--latest=false`, so that they are not marked as the latest release. A GitHub release runs the workflows as they are at the tagged commit, so a 1.x release tagged on `master` never runs this branch's `publish.yml` (`master` has no publish workflow).
