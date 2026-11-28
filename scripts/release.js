#!/usr/bin/env node

/*
 * Lockstep release tooling for the four published packages (@ably/laravel-echo and the React, Vue and Svelte
 * packages), which always release together on the same version. One command per release step:
 *
 *   node scripts/release.js check [--tag <tag>] [--pack]   check the versions (also run in CI)
 *   node scripts/release.js bump <version>                 move every version site to <version>
 *   node scripts/release.js publish [--stage] [--tag <dist-tag>] [--otp <code>] [--dry-run]
 *
 * check: the four versions agree, the version is X.Y.Z or X.Y.Z-rc.N, and the React, Vue and Svelte peer range on
 * @ably/laravel-echo matches it (^X.Y.Z for a release, ^X.Y.Z-rc.0 for a release candidate). --tag also requires
 * the git tag to be ably-echo-<version>. It prints the npm dist-tag for the version (`next` for a release candidate,
 * `latest` otherwise) and writes it to $GITHUB_OUTPUT when that is set. If $RELEASE_PRERELEASE (the GitHub release's
 * pre-release flag, set for a release event only) disagrees with the version, it emits a ::warning:: annotation. --pack then packs the four packages with
 * `pnpm pack` into release-tarballs/ (run `pnpm build` first) and checks each tarball: its version, every file its
 * main/module/types/exports fields name (npm pack silently omits missing files: 1.1.0 shipped a stale dist this
 * way), no workspace: or catalog: ranges, and the core's embedded version.
 *
 * publish publishes the tarballs in release-tarballs/ in order, the core first, each from its unpacked folder (npm
 * does not rewrite pnpm's workspace: and catalog: ranges, so it must not pack the package folders itself). --stage
 * runs `npm stage publish` instead, as the release workflow does: each version then waits on npmjs.com until a
 * maintainer approves it with 2FA, the core first. Packages already on npm at the version are skipped, so a failed
 * run can be re-run. Without --tag, the dist-tag is derived from the version.
 *
 * Only maintainers release: no agent or automation runs `bump`, `publish` or `publish --stage` for a real release,
 * or pushes or tags one. The release workflow stages, and a maintainer approves.
 */

// scripts/ has no @types/node, so type-aware lint sees Node's built-ins as untyped.
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, no-console */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const tarballDir = path.join(repoRoot, "release-tarballs");
const tagPrefix = "ably-echo-";

// Publish and approval order: the adapters peer-depend on the core, so the core goes first.
const packageDirs = [
    "packages/laravel-echo",
    "packages/react",
    "packages/vue",
    "packages/svelte",
];
const adapterDirs = packageDirs.slice(1);
const coreName = "@ably/laravel-echo";

// X.Y.Z or X.Y.Z-rc.N, without leading zeros.
const versionRe =
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(-rc\.(?:0|[1-9]\d*))?$/;

function readJson(relPath) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), "utf8"));
}

function writeJson(relPath, value) {
    fs.writeFileSync(
        path.join(repoRoot, relPath),
        JSON.stringify(value, null, 4) + "\n",
    );
}

function fail(message) {
    console.error(`release: ${message}`);
    process.exit(1);
}

/** The adapters' peer range on the core for a version, or null if it is not a release version. */
function peerRange(version) {
    const match = versionRe.exec(version);
    if (!match) {
        return null;
    }
    return match[2] === undefined ? `^${version}` : `^${match[1]}-rc.0`;
}

/** The npm dist-tag for a release version: a release candidate never goes to `latest`. */
function distTag(version) {
    return version.includes("-") ? "next" : "latest";
}

/**
 * The release guard, the same for a release event and a manual run: the tag (when given) must be ably-echo-<version>,
 * and the dist-tag follows from the version, so a release candidate never gets `latest`. `prerelease` is the GitHub
 * release's pre-release flag ('true' or 'false'; empty or undefined on a manual run): when it disagrees with the
 * version, that is only a warning, because the dist-tag comes from the version either way.
 */
function releaseGuard(version, tag, prerelease) {
    const npmTag = distTag(version);
    if (tag !== null && tag !== undefined && tag !== tagPrefix + version) {
        return {
            distTag: npmTag,
            problem: `the tag ${tag} does not match the package version ${version}`,
            warning: null,
        };
    }
    const candidate = version.includes("-");
    let warning = null;
    if (
        (prerelease === "true" || prerelease === "false") &&
        (prerelease === "true") !== candidate
    ) {
        warning =
            `${version} is ${candidate ? "a release candidate" : "a release"}, but its GitHub release is ` +
            `${prerelease === "true" ? "" : "not "}marked as a pre-release; staging it with the dist-tag ${npmTag}`;
    }
    return { distTag: npmTag, problem: null, warning };
}

/** Every file a manifest's entry points name: main, module, types, svelte and every exports target. */
function entryFiles(manifest) {
    const files = new Set();
    const add = (target) => {
        if (typeof target === "string") {
            files.add(target.replace(/^\.\//, ""));
        } else if (target && typeof target === "object") {
            Object.values(target).forEach(add);
        }
    };
    for (const field of ["main", "module", "types", "svelte"]) {
        add(manifest[field]);
    }
    add(manifest.exports);
    return [...files].sort((a, b) => a.localeCompare(b));
}

/** The problems with a packed manifest and its file list (paths relative to the package root). */
function tarballProblems(manifest, files, version) {
    const problems = [];
    if (manifest.version !== version) {
        problems.push(`version is ${manifest.version}, not ${version}`);
    }
    for (const file of entryFiles(manifest)) {
        if (!files.includes(file)) {
            problems.push(`${file} is missing (run 'pnpm build')`);
        }
    }
    if (/"(workspace|catalog):/.test(JSON.stringify(manifest))) {
        problems.push("a workspace: or catalog: range was not rewritten");
    }
    return problems;
}

/** Every place a release version is recorded, with the value it must have. */
function versionSites() {
    const version = readJson(packageDirs[0] + "/package.json").version;
    const sites = packageDirs.map((dir) => ({
        name: `${dir}/package.json version`,
        value: readJson(`${dir}/package.json`).version,
        expected: version,
    }));
    for (const dir of adapterDirs) {
        sites.push({
            name: `${dir}/package.json peerDependencies['${coreName}']`,
            value: readJson(`${dir}/package.json`).peerDependencies[coreName],
            expected: peerRange(version) ?? "<not a release version>",
        });
    }
    return { version, sites };
}

function check(args = []) {
    const { version, sites } = versionSites();
    if (!versionRe.test(version)) {
        fail(`${version} is not X.Y.Z or X.Y.Z-rc.N`);
    }
    const wrong = sites.filter((site) => site.value !== site.expected);
    if (wrong.length > 0) {
        console.error(
            "release: the version sites disagree; the four packages release in lockstep:",
        );
        for (const site of wrong) {
            console.error(
                `  ${String(site.value).padEnd(14)} ${site.name} (expected ${site.expected})`,
            );
        }
        fail(
            "run 'node scripts/release.js bump <version>' to move every site at once",
        );
    }

    const guard = releaseGuard(
        version,
        flagValue(args, "--tag", /^\S+$/),
        process.env.RELEASE_PRERELEASE,
    );
    if (guard.problem) {
        fail(guard.problem);
    }
    const npmTag = guard.distTag;
    if (guard.warning) {
        // GitHub Actions shows this as a warning annotation; it does not fail the run.
        console.log(`::warning::${guard.warning}`);
    }
    console.log(
        `release: all ${sites.length} version sites agree on ${version}; npm dist-tag ${npmTag}`,
    );
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `version=${version}\ndist-tag=${npmTag}\n`,
        );
    }
    if (args.includes("--pack")) {
        pack(version);
    }
    return version;
}

function pack(version) {
    fs.rmSync(tarballDir, { recursive: true, force: true });
    fs.mkdirSync(tarballDir);
    const problems = [];
    for (const dir of packageDirs) {
        const out = execFileSync(
            "pnpm",
            ["pack", "--json", "--pack-destination", tarballDir],
            { cwd: path.join(repoRoot, dir), encoding: "utf8" },
        );
        const tarball = JSON.parse(out.slice(out.indexOf("{"))).filename;
        const files = execFileSync("tar", ["-tzf", tarball], {
            encoding: "utf8",
        })
            .split("\n")
            .filter(Boolean)
            .map((entry) => entry.replace(/^package\//, ""));
        const read = (file) =>
            execFileSync("tar", ["-xzOf", tarball, `package/${file}`], {
                encoding: "utf8",
                maxBuffer: 64 * 1024 * 1024,
            });
        const manifest = JSON.parse(read("package.json"));
        const found = tarballProblems(manifest, files, version);
        // A dist built for another version (the 1.1.0 stale-dist lesson) embeds the wrong version.
        if (
            dir === packageDirs[0] &&
            !read("dist/echo.js").includes(`LIB_VERSION = "${version}"`)
        ) {
            found.push(`dist/echo.js does not embed ${version} (stale build?)`);
        }
        for (const problem of found) {
            problems.push(`${path.basename(tarball)}: ${problem}`);
        }
        console.log(
            `release: packed ${path.relative(repoRoot, tarball)} (${files.length} files, ${entryFiles(manifest).length} entry files)`,
        );
    }
    if (problems.length > 0) {
        fail(
            `the release tarballs are not publishable:\n  ${problems.join("\n  ")}`,
        );
    }
    console.log(
        `release: the four tarballs in release-tarballs/ are ready for ${version}`,
    );
}

function bump(version) {
    const peer = peerRange(version ?? "");
    if (peer === null) {
        fail(`bump requires X.Y.Z or X.Y.Z-rc.N, got '${version ?? ""}'`);
    }
    // Direct writes, as ably-js does: `pnpm version` refuses a dirty tree after the first package and re-sorts
    // dependencies. JSON.stringify keeps the key order.
    for (const dir of packageDirs) {
        const pkg = readJson(`${dir}/package.json`);
        pkg.version = version;
        if (adapterDirs.includes(dir)) {
            pkg.peerDependencies[coreName] = peer;
        }
        writeJson(`${dir}/package.json`, pkg);
    }
    check();
    console.log(
        `release: bumped the four packages to ${version} (adapters' peer ${peer}); review with 'git diff' and commit`,
    );
}

/** Returns true if name@version is already on the registry. */
function isPublished(name, version) {
    try {
        const out = execFileSync(
            "npm",
            ["view", `${name}@${version}`, "version"],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        ).trim();
        return out === version;
    } catch (err) {
        const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        // E404 covers an unpublished version and a package that has never been published.
        if (text.includes("E404") || text.includes("404 Not Found")) {
            return false;
        }
        throw new Error(
            `could not query the registry for ${name}@${version}: ${text.trim()}`,
        );
    }
}

/** Returns the value following `flag` in args, or null if the flag is absent. */
function flagValue(args, flag, pattern) {
    const index = args.indexOf(flag);
    if (index === -1) {
        return null;
    }
    const value = args[index + 1];
    // The value reaches npm's argv, so accept only what a real one looks like.
    if (value === undefined || value.startsWith("-") || !pattern.test(value)) {
        fail(
            `${flag} requires a value matching ${pattern}, got '${value ?? ""}'`,
        );
    }
    return value;
}

function publish(args) {
    const dryRun = args.includes("--dry-run");
    const stage = args.includes("--stage");
    const otp = flagValue(args, "--otp", /^\d+$/);
    const version = check();
    const tag =
        flagValue(args, "--tag", /^[A-Za-z][A-Za-z0-9._-]*$/) ??
        distTag(version);
    if (version.includes("-") && tag === "latest") {
        fail(`the release candidate ${version} must not be tagged latest`);
    }

    const state = packageDirs.map((dir) => {
        const name = readJson(`${dir}/package.json`).name;
        const tarball = path.join(
            tarballDir,
            `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`,
        );
        if (!fs.existsSync(tarball)) {
            fail(
                `${path.relative(repoRoot, tarball)} is missing; run 'pnpm build' and 'node scripts/release.js check --pack' first`,
            );
        }
        return { name, tarball, published: isPublished(name, version) };
    });
    const toPublish = state.filter((entry) => !entry.published);
    if (toPublish.length === 0) {
        console.log(
            `release: all four packages are already published at ${version}`,
        );
        return;
    }
    if (toPublish.length < state.length) {
        console.warn(
            `release: resuming ${version}; already published: ${state
                .filter((entry) => entry.published)
                .map((entry) => entry.name)
                .join(", ")}`,
        );
    }

    // npm (stage) publish packs the current folder, so each tarball is unpacked and published from there.
    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ably-echo-release-"),
    );
    for (const entry of toPublish) {
        entry.folder = path.join(workDir, path.basename(entry.tarball, ".tgz"));
        fs.mkdirSync(entry.folder);
        execFileSync("tar", ["-xzf", entry.tarball, "-C", entry.folder]);
        entry.folder = path.join(entry.folder, "package");
        // The tarball comes from `pnpm pack`, which rewrites workspace: and catalog: ranges; npm would not.
        const unpacked = fs.readFileSync(
            path.join(entry.folder, "package.json"),
            "utf8",
        );
        if (/"(workspace|catalog):/.test(unpacked)) {
            fail(
                `${entry.name}: the unpacked package.json still has a workspace: or catalog: range`,
            );
        }
        console.log(`release: dry-run pack of ${entry.name}@${version}`);
        execFileSync("npm", ["publish", "--dry-run", "--tag", tag], {
            cwd: entry.folder,
            stdio: "inherit",
        });
    }
    if (dryRun) {
        console.log(
            `release: --dry-run: would ${stage ? "stage" : "publish"} with dist-tag ${tag}, in order: ${toPublish.map((e) => e.name).join(", ")}`,
        );
        return;
    }

    const command = stage ? ["stage", "publish"] : ["publish"];
    const commandArgs = [
        ...command,
        "--tag",
        tag,
        ...(otp ? ["--otp", otp] : []),
    ];
    for (const entry of toPublish) {
        console.log(
            `release: ${stage ? "staging" : "publishing"} ${entry.name}@${version}`,
        );
        try {
            // stdio stays inherited so that npm's OTP prompt works.
            execFileSync("npm", commandArgs, {
                cwd: entry.folder,
                stdio: "inherit",
            });
        } catch {
            if (stage) {
                fail(
                    `staging ${entry.name}@${version} FAILED. The packages staged before it await approval on npmjs.com; ` +
                        "npm refuses to stage a version twice, so reject them (npm stage reject <stage-id>) and re-run the release.",
                );
            }
            fail(
                `publishing ${entry.name}@${version} FAILED. The packages before it are live; fix the cause and re-run ` +
                    "'node scripts/release.js publish', which skips the packages already on npm.",
            );
        }
    }
    if (stage) {
        console.log(
            `release: staged ${toPublish.map((e) => e.name).join(", ")} at ${version} (dist-tag ${tag})`,
        );
        console.log(
            "release: next: a maintainer approves each one with 2FA on npmjs.com (Staged Packages tab) or with npm stage approve, the core first",
        );
        return;
    }
    console.log(
        `release: published the four packages at ${version} (dist-tag ${tag})`,
    );
}

module.exports = {
    distTag,
    entryFiles,
    peerRange,
    releaseGuard,
    tarballProblems,
    versionRe,
};

if (require.main === module) {
    const [, , command, ...rest] = process.argv;
    switch (command) {
        case "check":
            check(rest);
            break;
        case "bump":
            bump(rest[0]);
            break;
        case "publish":
            publish(rest);
            break;
        default:
            fail(
                `unknown command '${command ?? ""}': use check [--tag <tag>] [--pack], bump <version>, or publish [--stage] [--tag <dist-tag>] [--otp <code>] [--dry-run]`,
            );
    }
}
