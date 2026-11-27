#!/bin/bash
# Tests the release helpers in scripts/release-lib.sh (the adapter peer range and the release notes), and that the
# tarball check uses the same adapter peer rule.
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
PEER_CASES="2.0.0:^2.0.0 2.1.0:^2.1.0 2.0.1:^2.0.1 10.20.30:^10.20.30 2.0.0-rc.0:^2.0.0-rc.0 2.0.0-rc.3:^2.0.0-rc.0 2.1.0-rc.2:^2.1.0-rc.0"
INVALID_VERSIONS="2.0 v2.0.0 2.0.0-beta.1 2.0.0-rc 2.0.0-rc.1.2 2.0.0+build ably-echo-2.0.0"

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

if [ "$failures" -gt 0 ]; then
    echo "$failures release helper test(s) failed." >&2
    exit 1
fi
echo "All release helper tests passed."
