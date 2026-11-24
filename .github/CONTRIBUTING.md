# Contributing to the Ably fork

This repository is Ably's fork of [laravel/echo](https://github.com/laravel/echo), published to npm as `@ably/laravel-echo`. The Ably-specific guide comes first. Upstream Laravel's contribution guide follows below, unchanged: on an upstream sync, keep both.

## Releasing

Normal releases from `master` follow the [Release Process in the README](README.md#release-process).

### Maintenance releases for older majors (1.x)

Use this once 2.0.0 is published and 1.x still gets fixes. `master` then holds 2.x and the npm `latest` dist-tag points to 2.x. 1.x patches (1.1.2, 1.1.3, ...) are released from the `1.x` branch and published under the npm dist-tag `latest-1`, so `latest` stays on 2.x.

Below, `<version>` is the 1.x version being released (e.g. `1.1.2`), `<previous-version>` is the last 1.x release (e.g. `1.1.1`), and the git tag is `ably-echo-<version>` as usual.

#### One-time setup

1. Cut the `1.x` branch before the first 2.0 commit lands on `master`. It must contain `scripts/release-pack.mjs` (`npm run release:pack`), which the steps below use.
    ```shell
    git fetch origin
    git log --oneline ably-echo-1.1.1..origin/master   # must list only 1.x-safe commits, such as release:pack
    git switch -c 1.x origin/master
    git push -u origin 1.x
    ```
    If 2.0 commits are already on `master`, cut it from the tag instead and bring in `release:pack` with a PR into `1.x`:
    ```shell
    git switch -c 1.x ably-echo-1.1.1
    git push -u origin 1.x
    git switch -c backport/release-pack-1.x origin/1.x
    git cherry-pick -x <release-pack-commit-sha>...   # the commit(s) that added release:pack; add -m 1 for a merge commit
    git push -u origin backport/release-pack-1.x
    gh pr create -R ably-forks/laravel-echo --base 1.x --title "[1.x] Add release:pack" \
      --body "Backport of <master-pr-url>"
    ```
2. CI needs no change: `.github/workflows/tests.yml` already runs on pushes to `'*.x'` branches and on every pull request.
3. Right after 2.0.0 is published, point the maintenance dist-tag at the last 1.x release, so `npm install @ably/laravel-echo@latest-1` works from day one:
    ```shell
    npm dist-tag add @ably/laravel-echo@1.1.1 latest-1
    npm view @ably/laravel-echo dist-tags   # latest: 2.x, latest-1: 1.1.1
    ```
4. Optional: ask a repository admin to protect `*.x` branches (pull requests only, required checks).

#### Backport a fix

1. Fix it on `master` first with a normal PR. Only a bug that exists in 1.x alone is fixed directly on a branch from `origin/1.x`.
2. Cherry-pick it into a PR against `1.x`. `-x` adds "(cherry picked from commit ...)" to the commit message.
    ```shell
    git fetch origin
    git switch -c backport/<topic>-1.x origin/1.x
    git cherry-pick -x <commit-sha-on-master>   # add -m 1 if the commit is a merge commit
    git push -u origin backport/<topic>-1.x
    gh pr create -R ably-forks/laravel-echo --base 1.x --title "[1.x] <fix summary>" \
      --body "Backport of <master-pr-url>"
    ```
3. Backports go from `master` to `1.x` only. Never merge or cherry-pick `1.x` release commits (version bump, changelog) into `master`.

#### Release a 1.x version

1. Open the release PR against `1.x`:
    ```shell
    git fetch origin
    git switch -c release/<version> origin/1.x
    npm version <version> --no-git-tag-version   # package.json and package-lock.json
    ```
    Add the entry at the top of [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md) on this branch. Write it by hand, or generate it as in the README with `--since-tag ably-echo-<previous-version>` and check the output:
    ```markdown
    ## [v<version>](https://github.com/ably-forks/laravel-echo/tree/ably-echo-<version>)

    [Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-<previous-version>...ably-echo-<version>)
    ```
    ```shell
    git commit -am "Prepare <version> release"
    git push -u origin release/<version>
    gh pr create -R ably-forks/laravel-echo --base 1.x --title "Release <version>" --body "Release <version>"
    ```
2. Once the PR is approved and merged into `1.x`, tag the merge commit by its SHA and push the tag:
    ```shell
    SHA=$(gh pr view <pr-number> -R ably-forks/laravel-echo --json mergeCommit -q .mergeCommit.oid)
    git fetch origin
    git merge-base --is-ancestor "$SHA" origin/1.x && echo "on 1.x"   # must print "on 1.x"
    git tag ably-echo-<version> "$SHA"
    git push origin ably-echo-<version>
    ```
3. Pack the tag, as in the README:
    ```shell
    git status --short                  # must print nothing; commit or stash first
    git checkout ably-echo-<version>
    git describe --tags --exact-match   # must print ably-echo-<version>
    npm run release:pack -- <version>   # creates ably-laravel-echo-<version>.tgz and prints its integrity
    ```
4. Publish the tarball with `--tag latest-1`, using npm 11 or later (`npm --version`). Do not run the `Publish:` line that `release:pack` prints: it has no `--tag`.
    ```shell
    npm whoami
    npm publish ./ably-laravel-echo-<version>.tgz --tag latest-1 --dry-run   # must say "with tag latest-1"
    npm publish ./ably-laravel-echo-<version>.tgz --tag latest-1
    ```
5. Create the GitHub release without taking "Latest" from 2.x. In the web UI, untick "Set as latest release".
    ```shell
    gh release create ably-echo-<version> -R ably-forks/laravel-echo --verify-tag --latest=false \
      --title v<version> --notes-file <notes-file>   # <notes-file>: the CHANGELOG-ABLY.md entry for <version>
    ```
    Then update the [Ably Changelog](https://changelog.ably.com/) as usual.
6. Verify:
    ```shell
    npm view @ably/laravel-echo dist-tags                   # latest: 2.x, latest-1: <version>
    npm view @ably/laravel-echo@<version> dist.integrity    # same as release:pack printed
    gh release list -R ably-forks/laravel-echo -L 3          # "Latest" is still the 2.x release
    ```
7. Optional: copy the changelog entry into `CHANGELOG-ABLY.md` on `master`, below the 2.x entries.

#### Pitfalls

- `--tag 1.x` and `--tag v1` fail with "Tag name must not be a valid SemVer range". Use `latest-1`.
- Never use `--tag latest` or `--force` for a 1.x release. Both skip npm's check and move `latest` to 1.x.
- npm 10 and older have no such check: `npm publish` without `--tag` silently moves `latest` to 1.x. Use npm 11 or later.
- Write the tarball path as `./ably-laravel-echo-<version>.tgz`. npm reads a path such as `dir/file.tgz` as a GitHub repository.
- Without `--latest=false`, `gh release create` makes the 1.x release "Latest". Without `--verify-tag`, a missing tag is created from `master`.
- Never move or re-push a published tag. Release the next patch instead.
- Do not `npm deprecate` 1.x while it is supported.
- If `latest` moved by mistake, restore it (list the published versions with `npm view @ably/laravel-echo versions`): `npm dist-tag add @ably/laravel-echo@<current-2.x-version> latest` and `npm dist-tag add @ably/laravel-echo@<version> latest-1`. Restore the GitHub badge with `gh release edit ably-echo-<current-2.x-version> -R ably-forks/laravel-echo --latest`.

#### Staying on 1.x (for users)

`npm install @ably/laravel-echo@^1`, or keep `^1.1` in `package.json`. A version range installs the highest matching 1.x whatever `latest` points to. `npm install @ably/laravel-echo@latest-1` also works. `npm outdated` then shows the newest 1.x as "Wanted" and 2.x as "Latest".

---

# Contribution Guide

The Laravel contributing guide can be found in the [Laravel documentation](https://laravel.com/docs/contributions).
