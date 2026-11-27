# Helpers for release.sh and the publish.yml release guard (scripts/release-guard.sh). Source this file; it only
# defines a constant and functions. scripts/test-release-lib.sh tests them: bash scripts/test-release-lib.sh

# One git tag, ably-echo-<version>, covers the four lockstep packages.
RELEASE_TAG_PREFIX="ably-echo-"

# A release version is X.Y.Z, or X.Y.Z-rc.N for a release candidate, with no leading zeros (as semver requires).
# Keep it equal to VERSION_PATTERN in scripts/check-release-tarballs.mjs.
is_release_version() {
    [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$ ]]
}

is_prerelease_version() {
    [[ "$1" == *-rc.* ]]
}

# The React, Vue and Svelte packages' peer range on @ably/laravel-echo for a release version (F-126):
#   X.Y.Z-rc.N -> ^X.Y.Z-rc.0  (an RC adapter admits every RC core of X.Y.Z, X.Y.Z itself and later releases)
#   X.Y.Z      -> ^X.Y.Z       (a final adapter requires at least the core it was released with)
# Keep it equal to adapterPeerRange() in scripts/check-release-tarballs.mjs.
adapter_peer_range() {
    local version=$1
    is_release_version "$version" || return 1
    if is_prerelease_version "$version"; then
        echo "^${version%%-rc.*}-rc.0"
    else
        echo "^$version"
    fi
}

# Prints the body of the "## [v<version>]" entry of a CHANGELOG-ABLY.md-style file (without its heading and the blank
# lines after it).
changelog_entry() {
    local changelog=$1 version=$2
    awk -v heading="## [v$version]" '
        index($0, heading) == 1 { found = 1; next }
        found && /^## / { exit }
        found && (started || NF) { started = 1; print }
    ' "$changelog"
}

# Prints the GitHub release notes for a version: its changelog entry or, for a release candidate without an entry of
# its own, the entry of the version it is a candidate for (without the "Full Changelog" link, whose tag does not exist
# yet). Fails when there is no entry.
release_notes() {
    local changelog=$1 version=$2 entry base
    entry=$(changelog_entry "$changelog" "$version")
    if [ -n "$(printf '%s' "$entry" | tr -d '[:space:]')" ]; then
        printf '%s\n' "$entry"
        return 0
    fi
    is_prerelease_version "$version" || return 1
    base=${version%%-rc.*}
    entry=$(changelog_entry "$changelog" "$base")
    [ -n "$(printf '%s' "$entry" | tr -d '[:space:]')" ] || return 1
    printf 'This is release candidate %s of %s, published to npm under the dist-tag `next`. The notes below are for %s.\n\n' "$version" "$base" "$base"
    printf '%s\n' "$entry" | grep -v '^\[Full Changelog\]' | awk 'started || NF { started = 1; print }'
}

# Prints X.Y.Z or X.Y.Z-rc.N from the tag ably-echo-<version>. Fails for any other tag (for example v2.0.0).
version_from_tag() {
    local tag=$1 version
    [[ "$tag" == "$RELEASE_TAG_PREFIX"* ]] || return 1
    version=${tag#"$RELEASE_TAG_PREFIX"}
    is_release_version "$version" || return 1
    echo "$version"
}

# Prints the npm dist-tag for a version and the GitHub release's prerelease flag (true or false): `next` for
# X.Y.Z-rc.N on a prerelease, `latest` for X.Y.Z on a release. Fails when they disagree, so that a release candidate
# never reaches `latest` and a release never goes to `next` only.
npm_dist_tag() {
    local version=$1 prerelease=$2
    is_release_version "$version" || return 1
    if [ "$prerelease" = true ] && is_prerelease_version "$version"; then
        echo next
    elif [ "$prerelease" = false ] && ! is_prerelease_version "$version"; then
        echo latest
    else
        return 1
    fi
}

# The release guard of publish.yml: checks a GitHub release's tag and prerelease flag against the four
# packages/*/package.json under <root>, and prints version=<version> and dist_tag=<next|latest>. Fails, with the
# reason on stderr, for anything that must not be published.
release_guard() {
    local tag=$1 prerelease=$2 root=${3:-.} version dist_tag dir manifest_version
    if ! version=$(version_from_tag "$tag"); then
        echo "The tag '$tag' is not ${RELEASE_TAG_PREFIX}X.Y.Z or ${RELEASE_TAG_PREFIX}X.Y.Z-rc.N." >&2
        return 1
    fi
    if ! dist_tag=$(npm_dist_tag "$version" "$prerelease"); then
        echo "The GitHub release's prerelease flag is '$prerelease', but $version is $(is_prerelease_version "$version" || echo "not ")a release candidate: a release candidate must be a prerelease (npm dist-tag next) and a release must not be (latest)." >&2
        return 1
    fi
    for dir in laravel-echo react vue svelte; do
        manifest_version=$(node -p 'require(require("path").resolve(process.argv[1])).version' "$root/packages/$dir/package.json") || return 1
        if [ "$manifest_version" != "$version" ]; then
            echo "packages/$dir/package.json is version $manifest_version, not $version (tag $tag)." >&2
            return 1
        fi
    done
    echo "version=$version"
    echo "dist_tag=$dist_tag"
}
