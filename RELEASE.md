# Release Process

This repository publishes four packages with one shared version (lockstep), using [semantic versioning](http://semver.org/): `@ably/laravel-echo`, `@ably/laravel-echo-react`, `@ably/laravel-echo-vue` and `@ably/laravel-echo-svelte`. Releases of the 2.x line are made from the `2.x` branch, and one git tag, `ably-echo-<version>`, covers all four packages. `<version>` is `X.Y.Z`, or `X.Y.Z-rc.N` for a release candidate.

The tooling is `scripts/release.js` (`check`, `bump`, `publish`) and the [release workflow](.github/workflows/release.yml), which stages the packages on npm with trusted publishing (OIDC); a maintainer then approves them with 2FA.

## Rules

- **Only maintainers release.** No agent or automation runs a real release, publish, stage, tag or push: not `release.js bump` or `publish` for a release, not `npm stage approve`, and not a tag or a GitHub release. A real release is done only by a maintainer, with the go-ahead.
- **Release together with laravel-broadcaster.** Echo 2.x works only with laravel-broadcaster 2.x. Release on the same day as the matching laravel-broadcaster release: Echo may go first, **never laravel-broadcaster first**.
- **Never rely on `prepublish*` or `postpublish` scripts.** CI builds explicitly and `release.js check --pack` checks every tarball before anything is staged.

## One-time setup

- On npmjs.com, each package has a trusted publisher: GitHub Actions, repository `ably-forks/laravel-echo`, workflow `release.yml`, environment `npm`.
- On GitHub, the repository has an environment named `npm`, with required reviewers.
- If npm cannot configure a trusted publisher for a package that has not been published yet, a maintainer publishes its first version with the manual fallback below, then configures the trusted publisher.

## Steps

1. **Changelog.** Add the release's entry to the top of [CHANGELOG-ABLY.md](CHANGELOG-ABLY.md).
2. **Bump.** On a branch from `2.x`, run `node scripts/release.js bump <version>`. It sets `<version>` in the four `package.json` files and the React, Vue and Svelte peer range on `@ably/laravel-echo`: `^X.Y.Z` for a release, `^X.Y.Z-rc.0` for a release candidate. Review the diff, commit `Release <version>`, and merge it into `2.x` by pull request. CI runs `pnpm run check:versions`.
3. **GitHub release.** Create the GitHub release titled `v<version>` for a new tag `ably-echo-<version>` on the merged commit, with the changelog entry as its notes. Mark a release candidate as a pre-release.
4. **Staging.** Publishing the GitHub release starts the release workflow. Its build job checks that the tag matches the four versions, builds, and packs and checks the four packages. Its stage job then stages them with `npm stage publish`, under the dist-tag `next` for a release candidate and `latest` otherwise. The workflow can also be run by hand for a tag (Actions → Release → Run workflow).
5. **Approval.** Approve each staged version with 2FA, on npmjs.com (Staged Packages tab) or with `npm stage approve <stage-id>`: `@ably/laravel-echo` first, then the React, Vue and Svelte packages.
6. **Check** with `npm view <package> dist-tags` for each package.
7. **Announce** a release (not a release candidate) in the [Ably Changelog](https://changelog.ably.com/) (via [headwayapp](https://headwayapp.co/)).

If staging fails partway, npm refuses to stage the same version twice: reject what was staged (`npm stage reject <stage-id>`), fix the cause and re-run the workflow.

**Manual fallback.** A maintainer can publish directly, with their own npm login and 2FA, from a clean checkout of the release commit: `pnpm install --frozen-lockfile`, `pnpm build`, `node scripts/release.js check --pack`, then `node scripts/release.js publish` (add `--dry-run` first to see what it would do). It publishes the checked tarballs in order, the core first, and skips any package already on npm at that version.

## Release candidates and 2.0.0

- Release `2.0.0-rc.N` first (dist-tag `next`) and test it with a laravel-broadcaster 2.x build before releasing `2.0.0` (dist-tag `latest`).
- At the 2.0.0 release, make `2.x` the repository's default branch on GitHub; `master` stays the 1.x line.

## 1.x maintenance releases

1.x releases (`@ably/laravel-echo` 1.x only) are made by hand from the `master` branch, following the release process documented there, under the npm dist-tag `latest-1`. Their GitHub releases are created with `--latest=false`. A GitHub release runs the workflows as they are at the tagged commit, and `master` has no release workflow, so a 1.x release never starts this one.
