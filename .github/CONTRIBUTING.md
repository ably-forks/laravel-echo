# Contributing to the Ably fork

This repository is Ably's fork of [laravel/echo](https://github.com/laravel/echo), published to npm as `@ably/laravel-echo`. The Ably-specific guide comes first. Upstream Laravel's contribution guide follows below, unchanged: on an upstream sync, keep both.

## Releasing

Normal releases from `master` follow the [Release Process in the README](README.md#release-process).

### Maintenance releases for older majors (1.x)

Use this once 2.0.0 is published from `master` and a fix must ship to 1.x users as a 1.x patch:
- 1.x patches (1.1.2, 1.1.3, ...) are released from the `1.x` branch.
- They are published under the npm dist-tag `latest-1`, so `latest` stays on 2.x.
- The `1.x` branch is not created in advance. Cut it when the first 1.x fix is needed.

Below, `<version>` is the 1.x version being released (e.g. `1.1.2`), `<previous-version>` is the last 1.x release (e.g. `1.1.1`), and the git tag is `ably-echo-<version>` as usual.

#### When 2.0.0 is published

Point `latest-1` at the last 1.x release, so `npm install @ably/laravel-echo@latest-1` works from day one:
```shell
npm view @ably/laravel-echo versions                              # the highest 1.x is <previous-version>
npm dist-tag add @ably/laravel-echo@<previous-version> latest-1
npm view @ably/laravel-echo dist-tags                             # latest: 2.x, latest-1: <previous-version>
```

#### Cut the `1.x` branch (first 1.x fix only)

1. When: cut `1.x` when the first fix that must ship as a 1.x patch is ready. Later fixes and releases reuse it.
2. From where: the last 1.x release tag, unless `master` has 1.x-safe commits right after it. List what `master` has since the tag, oldest first:
    ```shell
    git fetch origin --tags
    git log --oneline --first-parent --reverse ably-echo-<previous-version>..origin/master
    ```
    - If the list is empty or starts with 2.x work, `<base>` is `ably-echo-<previous-version>`.
    - If it starts with 1.x-safe commits (for example `release:pack`), `<base>` is the last of them before the first 2.x commit.
    ```shell
    git switch -c 1.x <base>
    git push -u origin 1.x
    ```
3. CI: `.github/workflows/tests.yml` runs on pushes to `'*.x'` branches in every tag since `ably-echo-1.0.2`, so a branch cut from a 1.1.x tag needs no workflow change. A branch keeps the workflow file it was cut from: if its `tests.yml` lacks `'*.x'` under `on.push.branches`, add it as the branch's first change.
4. `release:pack`: the release steps below need it. Check that the branch has it:
    ```shell
    git ls-tree --name-only origin/1.x scripts/release-pack.mjs   # must print scripts/release-pack.mjs
    ```
    If it prints nothing, backport the PR that added it as the first PR into `1.x`, as in [Backport a fix](#backport-a-fix). Cherry-pick that PR's merge commit with `-m 1`.
5. Optional: ask a repository admin to protect `*.x` branches (pull requests only, required checks).
6. Backport the fix, then release it as in [Release a 1.x version](#release-a-1x-version).

#### Backport a fix

1. Fix it on `master` first with a normal PR. Only a bug that exists in 1.x alone is fixed directly on a branch from `origin/1.x`.
    If `origin/1.x` does not exist yet, [cut it](#cut-the-1x-branch-first-1x-fix-only) first.
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
    Add the entry at the top of [CHANGELOG-ABLY.md](../CHANGELOG-ABLY.md) on this branch. Write it by hand, or generate it as in the README with `--since-tag ably-echo-<previous-version> --release-branch 1.x --exclude-tags-regex '^ably-echo-2\.'` and check the output. `--since-tag` alone also includes the newer 2.x tags, and `--release-branch` alone does not keep them out:
    ```markdown
    ## [v<version>](https://github.com/ably-forks/laravel-echo/tree/ably-echo-<version>)

    [Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-<previous-version>...ably-echo-<version>)
    ```
    ```shell
    git commit -am "Prepare <version> release"
    git push -u origin release/<version>
    gh pr create -R ably-forks/laravel-echo --base 1.x --title "Release <version>" --body "Release <version>"
    ```
2. Once the PR is approved and merged into `1.x`, tag its merge commit. Update your local `1.x` and check its last commit:
    ```shell
    git fetch origin
    git switch 1.x                        # first time, this creates 1.x tracking origin/1.x
    git pull --ff-only origin 1.x
    git log -1 --oneline                  # must be "Merge pull request ... from ably-forks/release/<version>"
    ```
    If the last line shows any other commit, stop. Otherwise, tag it and push the tag:
    ```shell
    git tag ably-echo-<version>
    git push origin ably-echo-<version>
    ```
3. Pack the tag, as in the README:
    ```shell
    git status --short --untracked-files=no   # must print nothing; commit or stash first
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
      --title v<version> --notes-file <notes-file>   # <notes-file>: the CHANGELOG-ABLY.md entry for <version>, without its ## heading
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
