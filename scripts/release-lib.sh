# Helpers for release.sh. Source this file; it only defines a constant and functions.
# scripts/test-release-lib.sh tests them: bash scripts/test-release-lib.sh

# One git tag, ably-echo-<version>, covers the four lockstep packages.
RELEASE_TAG_PREFIX="ably-echo-"

# A release version is X.Y.Z, or X.Y.Z-rc.N for a release candidate.
is_release_version() {
    [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]
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

# Prints the body of the "## [v<version>]" entry of a CHANGELOG-ABLY.md-style file (without its heading).
changelog_entry() {
    local changelog=$1 version=$2
    awk -v heading="## [v$version]" '
        index($0, heading) == 1 { found = 1; next }
        found && /^## / { exit }
        found { print }
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
    printf 'This is release candidate %s of %s, published to npm under the dist-tag `next`. The notes below are for %s.\n' "$version" "$base" "$base"
    printf '%s\n' "$entry" | grep -v '^\[Full Changelog\]'
}
