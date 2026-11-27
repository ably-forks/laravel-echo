#!/bin/bash
# Tests the release helpers in scripts/release-lib.sh (the adapter peer range, the release notes and the publish.yml
# release guard), that the tarball check uses the same adapter peer rule, and publish.yml's job conditions.
#
#   bash scripts/test-release-lib.sh
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/release-lib.sh
source scripts/release-lib.sh

failures=0

pass() {
    echo "ok    $1"
}

failed() {
    echo "FAIL  $1" >&2
    failures=$((failures + 1))
}

expect_equal() {
    local name=$1 actual=$2 expected=$3
    if [ "$actual" = "$expected" ]; then
        pass "$name"
    else
        failed "$name: expected '$expected', got '$actual'"
    fi
}

# The adapters' peer range: finals require the core they were released with, RCs admit every RC of that version.
PEER_CASES="2.0.0:^2.0.0 2.1.0:^2.1.0 2.0.1:^2.0.1 10.20.30:^10.20.30 0.0.0:^0.0.0 2.0.0-rc.0:^2.0.0-rc.0 2.0.0-rc.3:^2.0.0-rc.0 2.0.0-rc.10:^2.0.0-rc.0 2.1.0-rc.2:^2.1.0-rc.0"
INVALID_VERSIONS="2.0 v2.0.0 2.0.0-beta.1 2.0.0-rc 2.0.0-rc.1.2 2.0.0+build ably-echo-2.0.0 02.0.0 2.00.0 2.0.01 2.0.0-rc.01"

for case in $PEER_CASES; do
    version=${case%%:*}
    expect_equal "adapter_peer_range $version" "$(adapter_peer_range "$version")" "${case#*:}"
done

for version in $INVALID_VERSIONS ""; do
    if adapter_peer_range "$version" > /dev/null; then
        failed "adapter_peer_range rejects '$version'"
    else
        pass "adapter_peer_range rejects '$version'"
    fi
done

# scripts/check-release-tarballs.mjs must compute the same range (and reject the same versions).
versions=()
for case in $PEER_CASES; do
    versions+=("${case%%:*}")
done
for version in $INVALID_VERSIONS; do
    versions+=("$version")
done
js_results=$(node --input-type=module -e '
    import { adapterPeerRange } from "./scripts/check-release-tarballs.mjs";
    for (const version of process.argv.slice(1)) {
        process.stdout.write(`${version} ${adapterPeerRange(version) ?? "invalid"}\n`);
    }
' "${versions[@]}")
for version in "${versions[@]}"; do
    bash_result=$(adapter_peer_range "$version" || echo invalid)
    js_result=$(printf '%s\n' "$js_results" | awk -v v="$version" '$1 == v { print $2 }')
    expect_equal "check-release-tarballs.mjs agrees for $version" "$js_result" "$bash_result"
done

# Release notes come from CHANGELOG-ABLY.md.
changelog=$(mktemp "${TMPDIR:-/tmp}/release-lib-test.XXXXXX")
trap 'rm -f "$changelog"' EXIT
cat > "$changelog" << 'EOF'
# Changelog

## [v2.1.0](https://github.com/ably-forks/laravel-echo/tree/ably-echo-2.1.0)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-2.0.0...ably-echo-2.1.0)

- Entry for 2.1.0.

## [v2.0.0-rc.1](https://github.com/ably-forks/laravel-echo/tree/ably-echo-2.0.0-rc.1)

- Entry for 2.0.0-rc.1.

## [v2.0.0](https://github.com/ably-forks/laravel-echo/tree/ably-echo-2.0.0)

[Full Changelog](https://github.com/ably-forks/laravel-echo/compare/ably-echo-1.1.1...ably-echo-2.0.0)

- Entry for 2.0.0.

## [v1.1.1](https://github.com/ably-forks/laravel-echo/tree/ably-echo-1.1.1)

- Entry for 1.1.1.
EOF

notes=$(release_notes "$changelog" 2.1.0)
expect_equal "release_notes 2.1.0 keeps its entry" "$(printf '%s\n' "$notes" | grep -c 'Entry for 2.1.0')" 1
expect_equal "release_notes 2.1.0 stops at the next entry" "$(printf '%s\n' "$notes" | grep -c 'Entry for 2.0.0')" 0
expect_equal "release_notes 2.1.0 keeps the Full Changelog link" "$(printf '%s\n' "$notes" | grep -c '^\[Full Changelog\]')" 1

notes=$(release_notes "$changelog" 2.0.0)
expect_equal "release_notes 2.0.0 does not take the 2.0.0-rc.1 entry" "$(printf '%s\n' "$notes" | grep -c 'Entry for 2.0.0-rc.1')" 0
expect_equal "release_notes 2.0.0 keeps its entry" "$(printf '%s\n' "$notes" | grep -c 'Entry for 2.0.0\.')" 1

notes=$(release_notes "$changelog" 2.0.0-rc.1)
expect_equal "release_notes 2.0.0-rc.1 uses its own entry" "$(printf '%s\n' "$notes" | grep -c 'Entry for 2.0.0-rc.1')" 1

notes=$(release_notes "$changelog" 2.0.0-rc.0)
expect_equal "release_notes 2.0.0-rc.0 falls back to the 2.0.0 entry" "$(printf '%s\n' "$notes" | grep -c 'Entry for 2.0.0\.')" 1
expect_equal "release_notes 2.0.0-rc.0 says it is a release candidate" "$(printf '%s\n' "$notes" | grep -c 'release candidate 2.0.0-rc.0 of 2.0.0')" 1
expect_equal "release_notes 2.0.0-rc.0 drops the Full Changelog link" "$(printf '%s\n' "$notes" | grep -c 'Full Changelog')" 0

if release_notes "$changelog" 2.2.0 > /dev/null; then
    failed "release_notes fails without an entry (2.2.0)"
else
    pass "release_notes fails without an entry (2.2.0)"
fi
if release_notes "$changelog" 2.2.0-rc.0 > /dev/null; then
    failed "release_notes fails without an entry (2.2.0-rc.0)"
else
    pass "release_notes fails without an entry (2.2.0-rc.0)"
fi

# The publish.yml release guard: tag -> version -> npm dist-tag, checked against the four manifests.
expect_equal "version_from_tag ably-echo-2.0.0" "$(version_from_tag ably-echo-2.0.0)" 2.0.0
expect_equal "version_from_tag ably-echo-2.0.0-rc.1" "$(version_from_tag ably-echo-2.0.0-rc.1)" 2.0.0-rc.1
for tag in v2.0.0 2.0.0 ably-echo-v2.0.0 ably-echo-2.0.0-beta.1 ably-echo- "" ably-echo-2.0.0-rc.1-x ably-echo-02.0.0 ably-echo-2.0.0-rc.01; do
    if version_from_tag "$tag" > /dev/null; then
        failed "version_from_tag rejects '$tag'"
    else
        pass "version_from_tag rejects '$tag'"
    fi
done

expect_equal "npm_dist_tag 2.0.0 false" "$(npm_dist_tag 2.0.0 false)" latest
expect_equal "npm_dist_tag 2.0.0-rc.1 true" "$(npm_dist_tag 2.0.0-rc.1 true)" next
for case in 2.0.0:true 2.0.0-rc.1:false 2.0.0: 2.0.0-rc.1: 2.0.0:yes 2.0.0-beta.1:true; do
    if npm_dist_tag "${case%%:*}" "${case#*:}" > /dev/null; then
        failed "npm_dist_tag rejects version ${case%%:*} with prerelease '${case#*:}'"
    else
        pass "npm_dist_tag rejects version ${case%%:*} with prerelease '${case#*:}'"
    fi
done

fixture=$(mktemp -d "${TMPDIR:-/tmp}/release-guard-test.XXXXXX")
trap 'rm -f "$changelog"; rm -rf "$fixture"' EXIT
write_fixture() {
    local dir
    for dir in laravel-echo react vue svelte; do
        mkdir -p "$fixture/packages/$dir"
        printf '{ "name": "%s", "version": "%s" }\n' "$dir" "$1" > "$fixture/packages/$dir/package.json"
    done
    if [ $# -gt 1 ]; then
        printf '{ "name": "vue", "version": "%s" }\n' "$2" > "$fixture/packages/vue/package.json"
    fi
}

write_fixture 2.0.0
expect_equal "release_guard ably-echo-2.0.0, prerelease false" "$(release_guard ably-echo-2.0.0 false "$fixture" | tr '\n' ' ')" "version=2.0.0 dist_tag=latest "
write_fixture 2.0.0-rc.1
expect_equal "release_guard ably-echo-2.0.0-rc.1, prerelease true" "$(release_guard ably-echo-2.0.0-rc.1 true "$fixture" | tr '\n' ' ')" "version=2.0.0-rc.1 dist_tag=next "

expect_guard_failure() {
    local name=$1
    shift
    if release_guard "$@" > /dev/null 2>&1; then
        failed "release_guard fails: $name"
    else
        pass "release_guard fails: $name"
    fi
}
write_fixture 2.0.0
expect_guard_failure "tag v2.0.0" v2.0.0 false "$fixture"
expect_guard_failure "tag 2.0.0" 2.0.0 false "$fixture"
expect_guard_failure "tag ably-echo-2.0.1, packages at 2.0.0" ably-echo-2.0.1 false "$fixture"
expect_guard_failure "release (not prerelease) ably-echo-2.0.0 marked as a prerelease" ably-echo-2.0.0 true "$fixture"
expect_guard_failure "empty prerelease flag" ably-echo-2.0.0 "" "$fixture"
write_fixture 2.0.0-rc.1
expect_guard_failure "-rc version on a release not marked as a prerelease" ably-echo-2.0.0-rc.1 false "$fixture"
expect_guard_failure "tag ably-echo-2.0.0, packages at 2.0.0-rc.1" ably-echo-2.0.0 false "$fixture"
write_fixture 2.0.0 2.0.1
expect_guard_failure "one package (vue) at another version" ably-echo-2.0.0 false "$fixture"

# scripts/release-guard.sh on this checkout: it passes for the manifests' own version and writes $GITHUB_OUTPUT.
manifest_version=$(node -p 'require("./packages/laravel-echo/package.json").version')
if is_prerelease_version "$manifest_version"; then flag=true; want=next; else flag=false; want=latest; fi
output_file="$fixture/github-output"
: > "$output_file"
if GITHUB_OUTPUT="$output_file" bash scripts/release-guard.sh "ably-echo-$manifest_version" "$flag" > /dev/null; then
    expect_equal "release-guard.sh writes \$GITHUB_OUTPUT" "$(tr '\n' ' ' < "$output_file")" "version=$manifest_version dist_tag=$want "
else
    failed "release-guard.sh passes for ably-echo-$manifest_version"
fi
if bash scripts/release-guard.sh "v$manifest_version" "$flag" > /dev/null 2>&1; then
    failed "release-guard.sh fails for v$manifest_version"
else
    pass "release-guard.sh fails for v$manifest_version"
fi

# publish.yml's job and step conditions: the publish job runs only for a fork-style tag on a GitHub release.
if node scripts/test-publish-workflow.mjs; then
    pass "publish.yml conditions (scripts/test-publish-workflow.mjs)"
else
    failed "publish.yml conditions (scripts/test-publish-workflow.mjs)"
fi

if [ "$failures" -gt 0 ]; then
    echo "$failures release helper test(s) failed." >&2
    exit 1
fi
echo "All release helper tests passed."
