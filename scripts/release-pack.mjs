#!/usr/bin/env node
// Builds, packs and sanity-checks the npm package from the current checkout: `npm run release:pack -- [<version>]`.
// 1.1.0 shipped a stale dist/ and the upstream README, because `prepublishOnly` is skipped under `ignore-scripts=true`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const requested = process.argv[2];
const tarball = `ably-laravel-echo-${version}.tgz`;

const run = (command, ...args) =>
    execFileSync(command, args, { stdio: "inherit" });
const readFromTarball = (file) =>
    execFileSync("tar", ["-xzOf", tarball, `package/${file}`], {
        encoding: "utf8",
    });

if (requested && requested !== version) {
    console.error(
        `package.json is ${version}, not ${requested}. Run \`npm version ${requested} --no-git-tag-version\` or check out the release.`,
    );
    process.exit(1);
}

try {
    run("npm", "ci");
    rmSync("dist", { recursive: true, force: true });
    run("npm", "run", "build");
    run("npm", "run", "use:ablyReadme");
    run("npm", "pack", "--ignore-scripts");

    const bundle = readFromTarball("dist/echo.js");
    const readme = readFromTarball("README.md");
    const problems = [
        !bundle.includes("@ably/pubsub-device") &&
            "dist/echo.js does not use @ably/pubsub-device (stale build?)",
        !bundle.includes(`version = "${version}"`) &&
            !bundle.includes(`LIB_VERSION = '${version}'`) &&
            `dist/echo.js does not embed version ${version}`,
        (!readme.includes("@ably/pubsub-device") ||
            readme.includes("Logo Laravel Echo")) &&
            "README.md is not the Ably README",
    ].filter(Boolean);

    if (problems.length > 0) {
        throw new Error(problems.join("\n"));
    }

    console.log(`\nTarball:   ${tarball}`);
    console.log(
        `Integrity: sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
    );
    console.log(`Publish:   npm whoami && npm publish ${tarball}`);
} catch (error) {
    rmSync(tarball, { force: true });
    console.error(`\n${error.message}\nrelease:pack failed. Do not publish.`);
    process.exitCode = 1;
} finally {
    if (existsSync("base.README.md")) {
        run("npm", "run", "use:baseReadme");
    }
}
