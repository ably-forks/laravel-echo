// Tests for the pure parts of scripts/release.js: node --test scripts/release.test.js

// scripts/ has no @types/node, so type-aware lint sees Node's built-ins as untyped.
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-floating-promises */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
    distTag,
    entryFiles,
    filesIn,
    peerRange,
    releaseGuard,
    tarballProblems,
} = require("./release.js");

test("the adapters' peer range follows the version", () => {
    assert.equal(peerRange("2.0.0"), "^2.0.0");
    assert.equal(peerRange("2.1.0"), "^2.1.0");
    assert.equal(peerRange("0.0.0"), "^0.0.0");
    assert.equal(peerRange("2.0.0-rc.0"), "^2.0.0-rc.0");
    assert.equal(peerRange("2.1.0-rc.2"), "^2.1.0-rc.0");
    assert.equal(peerRange("2.0.0-rc.10"), "^2.0.0-rc.0");
});

test("only X.Y.Z and X.Y.Z-rc.N without leading zeros are release versions", () => {
    for (const version of [
        "2.0",
        "v2.0.0",
        "ably-echo-2.0.0",
        "2.0.0-beta.1",
        "2.0.0-rc",
        "2.0.0-rc.1.2",
        "2.0.0+build",
        "02.0.0",
        "2.00.0",
        "2.0.01",
        "2.0.0-rc.01",
        "",
    ]) {
        assert.equal(peerRange(version), null, version);
    }
});

test("a release candidate never gets the dist-tag latest", () => {
    assert.equal(distTag("2.0.0"), "latest");
    assert.equal(distTag("2.0.0-rc.0"), "next");
    assert.equal(distTag("2.1.0-rc.3"), "next");
});

const reactManifest = {
    version: "2.0.0",
    main: "dist/index.common.js",
    module: "dist/index.js",
    types: "dist/index.d.ts",
    exports: {
        ".": {
            types: "./dist/index.d.ts",
            "react-native": "./dist/index.common.js",
            import: "./dist/index.js",
            require: "./dist/index.common.cjs",
        },
        "./iife": "./dist/echo-react.iife.js",
    },
    peerDependencies: { "@ably/laravel-echo": "^2.0.0" },
    devDependencies: { "@ably/laravel-echo": "^2.0.0" },
};
const reactFiles = [
    "package.json",
    "README.md",
    "dist/index.common.js",
    "dist/index.common.cjs",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/echo-react.iife.js",
];

test("entry files cover main, module, types, svelte and every exports target", () => {
    assert.deepEqual(entryFiles(reactManifest), [
        "dist/echo-react.iife.js",
        "dist/index.common.cjs",
        "dist/index.common.js",
        "dist/index.d.ts",
        "dist/index.js",
    ]);
    assert.deepEqual(
        entryFiles({
            svelte: "./dist/index.js",
            exports: {
                ".": {
                    svelte: "./dist/index.js",
                    require: "./dist/index.common.cjs",
                },
            },
        }),
        ["dist/index.common.cjs", "dist/index.js"],
    );
});

test("a complete tarball has no problems", () => {
    assert.deepEqual(tarballProblems(reactManifest, reactFiles, "2.0.0"), []);
});

test("a missing entry file, another version or a workspace: range is a problem", () => {
    const withoutCjs = reactFiles.filter(
        (file) => file !== "dist/index.common.cjs",
    );
    assert.deepEqual(tarballProblems(reactManifest, withoutCjs, "2.0.0"), [
        "dist/index.common.cjs is missing (run 'pnpm build')",
    ]);
    assert.deepEqual(tarballProblems(reactManifest, reactFiles, "2.0.1"), [
        "version is 2.0.0, not 2.0.1",
    ]);
    const unrewritten = {
        ...reactManifest,
        devDependencies: {
            "@ably/laravel-echo": "workspace:^",
            typescript: "catalog:",
        },
    };
    assert.deepEqual(tarballProblems(unrewritten, reactFiles, "2.0.0"), [
        "a workspace: or catalog: range was not rewritten",
    ]);
});

test("the release guard is the same for a manual run and a release event", () => {
    // workflow_dispatch: no pre-release flag.
    assert.deepEqual(releaseGuard("2.0.0-rc.0", "ably-echo-2.0.0-rc.0", ""), {
        distTag: "next",
        problem: null,
        warning: null,
    });
    assert.deepEqual(releaseGuard("2.0.0", "ably-echo-2.0.0", undefined), {
        distTag: "latest",
        problem: null,
        warning: null,
    });
    // Release events whose pre-release flag matches the version.
    assert.equal(
        releaseGuard("2.0.0", "ably-echo-2.0.0", "false").warning,
        null,
    );
    assert.equal(
        releaseGuard("2.0.0-rc.1", "ably-echo-2.0.0-rc.1", "true").warning,
        null,
    );
    // A tag that is not ably-echo-<version> fails either way.
    for (const tag of ["v2.0.0", "2.0.0", "ably-echo-2.0.1"]) {
        assert.match(releaseGuard("2.0.0", tag, "").problem, /does not match/);
        assert.match(
            releaseGuard("2.0.0", tag, "false").problem,
            /does not match/,
        );
    }
});

test("a pre-release flag that disagrees with the version only warns", () => {
    const final = releaseGuard("2.0.0", "ably-echo-2.0.0", "true");
    assert.equal(final.distTag, "latest");
    assert.equal(final.problem, null);
    assert.match(
        final.warning,
        /2\.0\.0 is a release, but its GitHub release is marked as a pre-release/,
    );
    const candidate = releaseGuard(
        "2.0.0-rc.1",
        "ably-echo-2.0.0-rc.1",
        "false",
    );
    assert.equal(candidate.distTag, "next");
    assert.equal(candidate.problem, null);
    assert.match(
        candidate.warning,
        /is a release candidate, but its GitHub release is not marked/,
    );
});

test("an unpacked tarball is re-checked like the packed one, including its name", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
    try {
        for (const file of reactFiles) {
            fs.mkdirSync(path.dirname(path.join(folder, file)), {
                recursive: true,
            });
            fs.writeFileSync(path.join(folder, file), "");
        }
        const files = filesIn(folder);
        assert.deepEqual(
            [...files].sort((a, b) => a.localeCompare(b)),
            [...reactFiles].sort((a, b) => a.localeCompare(b)),
        );
        const manifest = { ...reactManifest, name: "@ably/laravel-echo-react" };
        assert.deepEqual(
            tarballProblems(
                manifest,
                files,
                "2.0.0",
                "@ably/laravel-echo-react",
            ),
            [],
        );
        assert.deepEqual(
            tarballProblems(manifest, files, "2.0.0", "@ably/laravel-echo-vue"),
            ["name is @ably/laravel-echo-react, not @ably/laravel-echo-vue"],
        );
        fs.rmSync(path.join(folder, "dist/index.js"));
        assert.deepEqual(
            tarballProblems(
                manifest,
                filesIn(folder),
                "2.0.0",
                "@ably/laravel-echo-react",
            ),
            ["dist/index.js is missing (run 'pnpm build')"],
        );
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
