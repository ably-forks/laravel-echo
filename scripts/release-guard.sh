#!/bin/bash
# The release guard of publish.yml, run before anything is packed or published:
#
#   bash scripts/release-guard.sh <tag> <prerelease: true|false>
#
# Fails unless the tag is ably-echo-<version>, the version is X.Y.Z (a release, not a prerelease: npm dist-tag
# `latest`) or X.Y.Z-rc.N (a prerelease: `next`), and all four packages/*/package.json are at <version>. Prints
# version=<version> and dist_tag=<next|latest>, and appends both to $GITHUB_OUTPUT when it is set.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/release-lib.sh
source scripts/release-lib.sh

if [ $# -ne 2 ]; then
    echo "Usage: bash scripts/release-guard.sh <tag> <prerelease: true|false>" >&2
    exit 1
fi

if ! result=$(release_guard "$1" "$2"); then
    echo "::error::Release guard: nothing is published for tag '$1' (prerelease: '$2')."
    exit 1
fi

echo "$result"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$result" >> "$GITHUB_OUTPUT"
fi
