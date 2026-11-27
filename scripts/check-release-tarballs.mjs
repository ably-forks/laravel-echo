#!/usr/bin/env node
// Packs the four lockstep packages into release-tarballs/ with `pnpm pack` and checks every tarball before it is published.
//
//   pnpm build
//   node scripts/check-release-tarballs.mjs [--tag ably-echo-<version> | --version <version>] [--prerelease true|false]
//
// The expected version comes from --tag (or the RELEASE_TAG environment variable), then --version, then
// packages/laravel-echo/package.json. --prerelease (or RELEASE_PRERELEASE) is the GitHub release's prerelease flag;
// it must match the version (`X.Y.Z-rc.N` is a prerelease, `X.Y.Z` is not).
//
// This script never builds and never relies on lifecycle scripts: `ignore-scripts=true` skips `prepublish*` and
// `postpublish`, which is how 1.1.0 shipped a stale dist/. Build explicitly first; the embedded version check below
// catches a dist/ built for another version. Exit code 0 means every check passed.
// scripts/ has no @types/node, so type-aware lint sees Node's built-ins as untyped. Plain Node, no TypeScript:
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "release-tarballs");
const PUBLISH_WORKFLOW = join(ROOT, ".github/workflows/publish.yml");
const TAG_PREFIX = "ably-echo-";
const REPOSITORY_URL = "https://github.com/ably-forks/laravel-echo";
// X.Y.Z or X.Y.Z-rc.N with no leading zeros; keep it equal to is_release_version in scripts/release-lib.sh.
const VERSION_PATTERN =
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(-rc\.(?:0|[1-9]\d*))?$/;
const LIFECYCLE_SCRIPTS = [
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
    "publish",
    "postpublish",
    "prepare",
    "preinstall",
    "install",
    "postinstall",
];

// Core first: the order matches the publish matrix.
const PACKAGES = [
    { dir: "laravel-echo", name: "@ably/laravel-echo" },
    { dir: "react", name: "@ably/laravel-echo-react", framework: "react" },
    { dir: "vue", name: "@ably/laravel-echo-vue", framework: "vue" },
    { dir: "svelte", name: "@ably/laravel-echo-svelte", framework: "svelte" },
];

const out = (line = "") => process.stdout.write(`${line}\n`);
const fail = (message) => {
    process.stderr.write(
        `\n${message}\nRelease tarball check failed. Do not publish.\n`,
    );
    process.exit(1);
};
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (!["--tag", "--version", "--prerelease"].includes(flag)) {
            fail(`Unknown argument: ${flag}`);
        }
        if (i + 1 >= argv.length) {
            fail(`${flag} needs a value`);
        }
        args[flag.slice(2)] = argv[++i];
    }
    return args;
}

// Empty values (for example RELEASE_TAG on a workflow_dispatch run) count as unset.
const nonEmpty = (...values) =>
    values.find((value) => value !== undefined && value !== "");

// The adapters' peer range on @ably/laravel-echo for a release version; keep it equal to adapter_peer_range in
// scripts/release-lib.sh (scripts/test-release-lib.sh checks both). F-126: an RC adapter admits the RC cores; a final
// adapter requires at least the core it was released with. Returns undefined for a version that is not X.Y.Z(-rc.N).
export function adapterPeerRange(version) {
    const match = VERSION_PATTERN.exec(version);
    if (!match) {
        return undefined;
    }
    return match[2] === undefined ? `^${version}` : `^${match[1]}-rc.0`;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function resolveExpected(args) {
    const tag = nonEmpty(args.tag, process.env.RELEASE_TAG);
    let version;
    if (tag !== undefined) {
        if (!tag.startsWith(TAG_PREFIX)) {
            fail(`Tag ${tag} does not start with ${TAG_PREFIX}.`);
        }
        version = tag.slice(TAG_PREFIX.length);
    } else {
        version =
            nonEmpty(args.version) ??
            readJson(join(ROOT, "packages/laravel-echo/package.json")).version;
    }

    const peer = adapterPeerRange(version);
    if (peer === undefined) {
        fail(`Version ${version} is not X.Y.Z or X.Y.Z-rc.N.`);
    }
    const prerelease = version.includes("-");

    const flag = nonEmpty(args.prerelease, process.env.RELEASE_PRERELEASE);
    if (flag !== undefined) {
        if (flag !== "true" && flag !== "false") {
            fail(`--prerelease must be true or false, not ${flag}.`);
        }
        if ((flag === "true") !== prerelease) {
            fail(
                `The GitHub release is ${flag === "true" ? "" : "not "}marked as a prerelease, but ${version} is ${prerelease ? "" : "not "}a prerelease version. ` +
                    "A prerelease is published under `next`, a release under `latest`: fix the release, not the check.",
            );
        }
    }

    return { tag, version, prerelease, peer };
}

// Every file a package.json entry point names: main, module, types, svelte and each exports target.
function entryFiles(manifest) {
    const files = new Set();
    const add = (target) => {
        if (typeof target === "string") {
            files.add(target.replace(/^\.\//, ""));
        } else if (target && typeof target === "object") {
            Object.values(target).forEach(add);
        }
    };
    ["main", "module", "types", "typings", "svelte", "browser"].forEach(
        (field) => add(manifest[field]),
    );
    add(manifest.exports);
    return [...files].sort((a, b) => a.localeCompare(b));
}

function preflight(expected) {
    for (const pkg of PACKAGES) {
        const dir = join(ROOT, "packages", pkg.dir);
        const manifest = readJson(join(dir, "package.json"));
        if (manifest.name !== pkg.name) {
            fail(
                `packages/${pkg.dir}/package.json is ${manifest.name}, not ${pkg.name}.`,
            );
        }
        if (manifest.version !== expected.version) {
            fail(
                `packages/${pkg.dir}/package.json is version ${manifest.version}, not ${expected.version}. ` +
                    "Bump all four packages with ./release.sh, or check out the release commit.",
            );
        }
        const missing = entryFiles(manifest).filter(
            (file) => !existsSync(join(dir, file)),
        );
        if (missing.length > 0) {
            fail(
                `packages/${pkg.dir} has no ${missing.join(", ")}. Run \`pnpm build\` first.`,
            );
        }
    }
}

function pack(pkg) {
    const json = execFileSync(
        "pnpm",
        ["pack", "--json", "--pack-destination", OUT_DIR],
        {
            cwd: join(ROOT, "packages", pkg.dir),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
        },
    );
    return JSON.parse(json.slice(json.indexOf("{"))).filename;
}

const tarList = (tarball) =>
    execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
const tarRead = (tarball, file) =>
    execFileSync("tar", ["-xzOf", tarball, `package/${file}`], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });

// The publish matrix's tgz globs (`*` and `[0-9]` only), so that each glob picks exactly one tarball (V2-P N5).
function publishGlobs() {
    if (!existsSync(PUBLISH_WORKFLOW)) {
        return [];
    }
    const pattern = /^ +- \{ package: ([\w-]+), tgz: '([^']+)' \}/gm;
    return [...readFileSync(PUBLISH_WORKFLOW, "utf8").matchAll(pattern)].map(
        ([, pkg, glob]) => ({
            pkg,
            glob,
            regex: new RegExp(
                `^${glob
                    .split(/(\*|\[0-9\])/)
                    .map((part) =>
                        part === "*"
                            ? ".*"
                            : part === "[0-9]"
                              ? "[0-9]"
                              : escapeRegExp(part),
                    )
                    .join("")}$`,
            ),
        }),
    );
}

function checkTarball(pkg, tarball, expected, check) {
    const entries = tarList(tarball);
    const files = new Set(
        entries
            .filter((entry) => !entry.endsWith("/"))
            .map((entry) => entry.replace(/^package\//, "")),
    );
    const has = (file) => files.has(file);
    const read = (file) => (has(file) ? tarRead(tarball, file) : "");
    const jsFiles = [...files].filter((file) =>
        /^dist\/.*\.(c?js)$/.test(file),
    );

    const fileName = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${expected.version}.tgz`;
    check("tarball name", tarball.endsWith(`/${fileName}`), fileName);

    const outside = entries.filter((entry) => !entry.startsWith("package/"));
    check(
        "every entry is under package/",
        outside.length === 0,
        outside.join(", "),
    );
    const unexpected = [...files].filter(
        (file) =>
            !/^(package\.json|README\.md|LICENSE(\.md)?|dist\/.+)$/.test(
                file,
            ) || /^dist\/(src|tests)\//.test(file),
    );
    check(
        "only dist/, package.json, README and LICENSE (no tests/, resources/boost, dist/src, dist/tests)",
        unexpected.length === 0,
        unexpected.join(", "),
    );
    check("LICENSE is included", has("LICENSE.md") || has("LICENSE"));

    const manifestText = read("package.json");
    const manifest = JSON.parse(manifestText);
    check("name", manifest.name === pkg.name, manifest.name);
    check(
        "version equals the release version",
        manifest.version === expected.version,
        manifest.version,
    );
    check(
        "repository.url",
        manifest.repository?.url === REPOSITORY_URL,
        manifest.repository?.url,
    );
    check(
        "repository.directory",
        manifest.repository?.directory === `packages/${pkg.dir}`,
        manifest.repository?.directory,
    );
    check(
        "no workspace: or catalog: ranges left",
        !/"(workspace|catalog):/.test(manifestText),
    );
    check(
        "publishConfig: public access and provenance",
        manifest.publishConfig?.access === "public" &&
            manifest.publishConfig?.provenance === true,
        JSON.stringify(manifest.publishConfig),
    );
    const lifecycle = LIFECYCLE_SCRIPTS.filter(
        (name) => manifest.scripts?.[name] !== undefined,
    );
    check(
        "no publish or install lifecycle scripts",
        lifecycle.length === 0,
        lifecycle.join(", "),
    );

    const missingEntries = entryFiles(manifest).filter((file) => !has(file));
    check(
        `every main/module/types/exports file is in the tarball (${entryFiles(manifest).length})`,
        missingEntries.length === 0,
        missingEntries.join(", "),
    );

    const readme = read("README.md");
    check(
        "README is the Ably one (no upstream logo)",
        readme !== "" && !readme.includes("Logo Laravel Echo"),
    );

    if (pkg.framework === undefined) {
        const esm = read("dist/echo.js");
        const cjs = read("dist/echo.common.cjs");
        const iife = read("dist/echo.iife.js");
        const versionPattern = new RegExp(
            `LIB_VERSION\\s*=\\s*["'\`]${escapeRegExp(expected.version)}["'\`]`,
        );

        check(
            "core entry files: dist/echo.js, echo.common.cjs, echo.iife.js, echo.d.ts",
            [
                "dist/echo.js",
                "dist/echo.common.cjs",
                "dist/echo.iife.js",
                "dist/echo.d.ts",
            ].every(has),
        );
        check(
            "README mentions @ably/pubsub-device",
            readme.includes("@ably/pubsub-device"),
        );
        check(
            "dependencies include @ably/pubsub-device",
            manifest.dependencies?.["@ably/pubsub-device"] !== undefined,
        );
        check(
            "ESM imports @ably/pubsub-device (external)",
            /\bfrom\s*["']@ably\/pubsub-device["']/.test(esm) &&
                !esm.includes("XMLHttpRequest"),
        );
        check(
            "CommonJS requires @ably/pubsub-device (external)",
            /\brequire\(\s*["']@ably\/pubsub-device["']\s*\)/.test(cjs) &&
                !cjs.includes("XMLHttpRequest"),
        );
        check(
            // The IIFE's hint strings say `from "@ably/pubsub-device/push"`, so look for require( and import( only.
            "IIFE bundles @ably/pubsub-device (XMLHttpRequest; no require( or import()",
            iife.includes("XMLHttpRequest") &&
                !iife.includes("require(") &&
                !/\bimport\(/.test(iife),
        );
        for (const [file, text] of [
            ["echo.js", esm],
            ["echo.common.cjs", cjs],
            ["echo.iife.js", iife],
        ]) {
            check(
                `dist/${file} embeds LIB_VERSION ${expected.version}`,
                versionPattern.test(text),
            );
        }
        return;
    }

    const { framework } = pkg;
    const iifeFile = `dist/echo-${framework}.iife.js`;
    const esm = read("dist/index.js");
    const cjs = read("dist/index.common.cjs");
    check(
        `adapter entry files: dist/index.js, index.common.cjs, index.d.ts, echo-${framework}.iife.js`,
        [
            "dist/index.js",
            "dist/index.common.cjs",
            "dist/index.d.ts",
            iifeFile,
        ].every(has),
    );
    check(
        "ESM imports @ably/laravel-echo",
        /\bfrom\s*["']@ably\/laravel-echo["']/.test(esm),
    );
    check(
        "CommonJS requires @ably/laravel-echo",
        /\brequire\(\s*["']@ably\/laravel-echo["']\s*\)/.test(cjs),
    );
    check(
        "IIFE uses the global Echo (core loaded first)",
        /\(\{\},\s*Echo\b/.test(read(iifeFile)),
    );
    const bundled = jsFiles.filter((file) =>
        /Ably JavaScript Library|XMLHttpRequest|LIB_VERSION/.test(read(file)),
    );
    check(
        "neither the Ably SDK nor the core is bundled",
        bundled.length === 0,
        bundled.join(", "),
    );
    const peer = manifest.peerDependencies?.["@ably/laravel-echo"];
    check(
        `peerDependencies @ably/laravel-echo is ${expected.peer} (${expected.prerelease ? "prerelease" : "release"})`,
        peer === expected.peer,
        peer,
    );
    check(
        `README names ${pkg.name}`,
        readme.includes(pkg.name) && !readme.includes("@laravel/echo-"),
    );
    if (framework === "react") {
        check(
            "dist/index.common.js equals dist/index.common.cjs",
            has("dist/index.common.js") && read("dist/index.common.js") === cjs,
        );
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const expected = resolveExpected(args);
    out(
        `Release ${expected.version} (${expected.prerelease ? "prerelease, npm dist-tag next" : "release, npm dist-tag latest"}); adapters' peer ${expected.peer}${expected.tag ? `; tag ${expected.tag}` : ""}`,
    );

    preflight(expected);
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });

    const failures = [];
    const tarballs = [];
    for (const pkg of PACKAGES) {
        const tarball = pack(pkg);
        tarballs.push(tarball);
        out(`\n${pkg.name}: ${tarball.slice(ROOT.length + 1)}`);
        checkTarball(pkg, tarball, expected, (name, ok, detail) => {
            out(
                `  ${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `: ${detail}` : ""}`,
            );
            if (!ok) {
                failures.push(`${pkg.name}: ${name}`);
            }
        });
    }

    const packed = readdirSync(OUT_DIR).filter((file) => file.endsWith(".tgz"));
    out(`\nrelease-tarballs/ holds ${packed.length} tarballs`);
    if (packed.length !== PACKAGES.length) {
        failures.push(
            `release-tarballs/ holds ${packed.length} tarballs, not ${PACKAGES.length}`,
        );
    }
    const globs = publishGlobs();
    for (const { pkg, glob, regex } of globs) {
        const matches = packed.filter((file) => regex.test(file));
        const wanted = PACKAGES.find((p) => p.dir === pkg);
        const ok =
            matches.length === 1 &&
            wanted !== undefined &&
            matches[0].startsWith(
                `${wanted.name.replace(/^@/, "").replace("/", "-")}-`,
            );
        out(
            `  ${ok ? "ok  " : "FAIL"}  publish.yml ${pkg} glob ${glob} matches exactly its tarball${ok ? "" : `: ${matches.join(", ") || "none"}`}`,
        );
        if (!ok) {
            failures.push(`publish.yml glob ${glob}`);
        }
    }
    if (existsSync(PUBLISH_WORKFLOW) && globs.length !== PACKAGES.length) {
        failures.push(
            `publish.yml has ${globs.length} matrix tgz globs, not ${PACKAGES.length}`,
        );
    }

    out(
        "\nsha512 integrity (compare with npm's `dist.integrity` after publishing):",
    );
    for (const tarball of tarballs) {
        const data = readFileSync(tarball);
        out(
            `  sha512-${createHash("sha512").update(data).digest("base64")}  ${data.length} bytes  ${tarball.slice(OUT_DIR.length + 1)}`,
        );
    }

    if (failures.length > 0) {
        fail(`${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
    }
    out(`\nAll release tarball checks passed for ${expected.version}.`);
}

// Run only as a script, so that scripts/test-release-lib.sh can import adapterPeerRange.
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    main();
}
