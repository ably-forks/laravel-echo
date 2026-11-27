#!/bin/bash
# Releases the four lockstep packages, @ably/laravel-echo, -react, -vue and -svelte, from the 2.x branch.
#
#   ./release.sh <version>            for example ./release.sh 2.0.0-rc.0 or ./release.sh 2.0.0
#   DRY_RUN=1 ./release.sh <version>  bump, build and check locally, print what would be committed, tagged, pushed and
#                                     released, then restore the changed files. Nothing leaves the machine.
#
# It bumps all four packages, sets the adapters' peer range on @ably/laravel-echo, updates the lockfile, builds and
# checks the tarballs (scripts/check-release-tarballs.mjs), then commits "Release <version>", tags
# ably-echo-<version>, pushes both and creates the GitHub release (a prerelease for X.Y.Z-rc.N). The GitHub release
# starts .github/workflows/publish.yml, which publishes to npm. The push and the release need the maintainers'
# go-ahead (RELEASE.md); the script asks for the version again before it commits.
set -euo pipefail

REPO="ably-forks/laravel-echo"
BRANCH="2.x"
CORE_PACKAGE_JSON="packages/laravel-echo/package.json"
RELEASE_FILES=(packages/laravel-echo/package.json packages/react/package.json packages/vue/package.json packages/svelte/package.json pnpm-lock.yaml)
DRY_RUN="${DRY_RUN:-0}"

cd "$(dirname "$0")"
# shellcheck source=scripts/release-lib.sh
source scripts/release-lib.sh

error() {
    echo "Error: $*" >&2
    exit 1
}

run() {
    echo "+ $*"
    "$@"
}

would_run() {
    echo "[dry run] would run: $*"
}

package_field() {
    node -p 'const [file, field] = process.argv.slice(1); require(require("path").resolve(file))[field]' "$1" "$2"
}

if [ $# -ne 1 ]; then
    echo "Usage: ./release.sh <version>   (X.Y.Z, or X.Y.Z-rc.N for a release candidate)" >&2
    echo "       DRY_RUN=1 ./release.sh <version>" >&2
    exit 1
fi

VERSION=$1
is_release_version "$VERSION" || error "$VERSION is not X.Y.Z or X.Y.Z-rc.N."
PEER=$(adapter_peer_range "$VERSION")
TAG="$RELEASE_TAG_PREFIX$VERSION"
if is_prerelease_version "$VERSION"; then
    PRERELEASE=true
    RELEASE_FLAG="--prerelease"
else
    PRERELEASE=false
    RELEASE_FLAG="--latest"
fi

[ "$DRY_RUN" = 1 ] && echo "Dry run: nothing is committed, tagged, pushed or released, and the changed files are restored at the end."

# Ensure we are on the release branch and the working tree is clean.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    [ "$DRY_RUN" = 1 ] || error "must be on $BRANCH (current: $CURRENT_BRANCH)."
    echo "Warning: not on $BRANCH (current: $CURRENT_BRANCH); allowed in a dry run only."
fi

if [ -n "$(git status --porcelain)" ]; then
    git status --porcelain >&2
    error "the working tree is not clean. Commit or stash your changes before releasing."
fi

if [ "$DRY_RUN" = 1 ]; then
    would_run git pull --ff-only origin "$BRANCH"
else
    run git pull --ff-only origin "$BRANCH"
fi

# The lockfile must be written by the pnpm version the repository pins (packageManager).
PNPM_WANTED=$(package_field package.json packageManager)
[ "pnpm@$(pnpm --version)" = "$PNPM_WANTED" ] || error "pnpm $(pnpm --version) is on PATH, but package.json wants $PNPM_WANTED (see CONTRIBUTING.md)."

CURRENT_VERSION=$(package_field "$CORE_PACKAGE_JSON" version)
echo ""
echo "Current version: $CURRENT_VERSION"
echo "New version:     $VERSION (tag $TAG, GitHub release $RELEASE_FLAG, npm dist-tag $([ "$PRERELEASE" = true ] && echo next || echo latest))"
echo "Adapters' peer:  @ably/laravel-echo $PEER"
echo ""

for file in "${RELEASE_FILES[@]:0:4}"; do
    [ "$(package_field "$file" version)" = "$CURRENT_VERSION" ] || error "$file is not at $CURRENT_VERSION: the packages are not in lockstep."
done
[ "$VERSION" != "$CURRENT_VERSION" ] || error "the packages are already at $VERSION."

# The tag and the npm versions must not exist yet (read-only checks).
if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
    error "tag $TAG already exists locally."
fi
remote_status=0
git ls-remote --exit-code --tags origin "refs/tags/$TAG" > /dev/null || remote_status=$?
case $remote_status in
    0) error "tag $TAG already exists on origin." ;;
    2) ;;
    *) error "could not list the tags on origin (git ls-remote exit code $remote_status)." ;;
esac
for file in "${RELEASE_FILES[@]:0:4}"; do
    name=$(package_field "$file" name)
    published=$(npm view "$name@$VERSION" version 2> /dev/null || true)
    [ -z "$published" ] || error "$name@$VERSION is already on npm."
done

NOTES_FILE=$(mktemp "${TMPDIR:-/tmp}/ably-echo-release-notes.XXXXXX")
release_notes CHANGELOG-ABLY.md "$VERSION" > "$NOTES_FILE" ||
    error "CHANGELOG-ABLY.md has no entry for $VERSION$([ "$PRERELEASE" = true ] && echo " or ${VERSION%%-rc.*}"). Add it first."

# From here on, restore the release files if the script stops before committing them.
COMMITTED=0
restore_release_files() {
    rm -f "$NOTES_FILE"
    if [ "$COMMITTED" = 0 ] && [ -n "$(git status --porcelain -- "${RELEASE_FILES[@]}")" ]; then
        echo "Restoring ${RELEASE_FILES[*]}."
        git checkout -- "${RELEASE_FILES[@]}"
    fi
}
trap restore_release_files EXIT

echo "Updating the version of all four packages..."
# --no-git-checks: pnpm 12's own `pnpm version` refuses a dirty working tree, which it is after the first package.
run pnpm -r --filter './packages/*' exec pnpm version "$VERSION" --no-git-tag-version --no-git-checks
for file in "${RELEASE_FILES[@]:0:4}"; do
    [ "$(package_field "$file" version)" = "$VERSION" ] || error "$file was not updated to $VERSION."
done

echo "Setting the adapters' peer range on @ably/laravel-echo to $PEER..."
for adapter in react vue svelte; do
    file="packages/$adapter/package.json"
    # Only the peer range starts with a digit after ^; the devDependency stays "workspace:^".
    PEER="$PEER" perl -pi -e 's/^(\s*"\@ably\/laravel-echo": ")\^[0-9][^"]*(",?)$/$1$ENV{PEER}$2/' "$file"
    node -e '
        const [file, peer] = process.argv.slice(1);
        const manifest = require(require("path").resolve(file));
        if (manifest.peerDependencies["@ably/laravel-echo"] !== peer || manifest.devDependencies["@ably/laravel-echo"] !== "workspace:^") {
            console.error(`${file}: peer ${manifest.peerDependencies["@ably/laravel-echo"]}, devDependency ${manifest.devDependencies["@ably/laravel-echo"]}`);
            process.exit(1);
        }
    ' "$file" "$PEER" || error "could not set the peer range in $file."
done

echo "Updating the lockfile..."
run pnpm install

echo "Building and checking the release tarballs..."
run pnpm build
run node scripts/check-release-tarballs.mjs --version "$VERSION" --prerelease "$PRERELEASE"

CHANGED=$(git status --porcelain --untracked-files=all)
UNEXPECTED=$(git status --porcelain --untracked-files=all -- . $(printf ":!%s " "${RELEASE_FILES[@]}"))
echo ""
git --no-pager diff -- 'packages/*/package.json'
git --no-pager diff --stat
[ -z "$UNEXPECTED" ] || error "unexpected changes besides ${RELEASE_FILES[*]}:
$UNEXPECTED"
[ -n "$CHANGED" ] || error "nothing changed."

echo ""
echo "Release notes ($NOTES_FILE):"
sed 's/^/    /' "$NOTES_FILE" | head -20
echo "    ..."

if [ "$DRY_RUN" = 1 ]; then
    echo ""
    would_run git add "${RELEASE_FILES[@]}"
    would_run git commit -m "Release $VERSION"
    would_run git tag -a "$TAG" -m "Release $VERSION"
    would_run git push origin "$BRANCH"
    would_run git push origin "$TAG"
    would_run gh release create "$TAG" --repo "$REPO" --title "v$VERSION" --notes-file "<release notes>" --verify-tag "$RELEASE_FLAG"
    echo ""
    echo "Dry run complete. dist/ and release-tarballs/ (both git-ignored) now hold the $VERSION build; run \`pnpm build\` to rebuild."
    exit 0
fi

echo ""
read -r -p "Commit \"Release $VERSION\", tag $TAG, push both to origin and create the GitHub release? Type $VERSION to continue: " answer
[ "$answer" = "$VERSION" ] || error "cancelled."

git add "${RELEASE_FILES[@]}"
git commit -m "Release $VERSION"
COMMITTED=1
git tag -a "$TAG" -m "Release $VERSION"
git push origin "$BRANCH"
git push origin "$TAG"

gh release create "$TAG" --repo "$REPO" --title "v$VERSION" --notes-file "$NOTES_FILE" --verify-tag "$RELEASE_FLAG"

echo ""
echo "Release $TAG created; publish.yml now publishes the four packages under the npm dist-tag $([ "$PRERELEASE" = true ] && echo next || echo latest)."
echo "https://github.com/$REPO/releases/tag/$TAG"
echo "https://github.com/$REPO/actions/workflows/publish.yml"
