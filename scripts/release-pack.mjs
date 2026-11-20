#!/usr/bin/env node
/*
 * Builds, packs and verifies the npm package in one go: `npm run release:pack`.
 *
 * It runs `npm run build`, swaps in the Ably README, runs `npm pack --ignore-scripts`, and verifies the tarball with
 * scripts/verify-package.mjs. The README is always restored afterwards, even if a step fails. Everything is called
 * explicitly, so it works under `ignore-scripts=true` (which skips npm lifecycle hooks such as `prepublishOnly`).
 * It publishes nothing. CI (.github/workflows/package.yml) runs this same script.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tarball = `ably-laravel-echo-${version}.tgz`;

if (existsSync('base.README.md')) {
    console.error('base.README.md exists: a previous run left the Ably README swapped in. Run `npm run use:baseReadme` first.');
    process.exit(2);
}

try {
    // Drop any old build output so that nothing stale can be packed.
    rmSync('dist', { recursive: true, force: true });

    run('npm', ['run', 'build']);
    run('npm', ['run', 'use:ablyReadme']);
    run('npm', ['pack', '--ignore-scripts']);
    run('node', ['scripts/verify-package.mjs', tarball, version]);

    console.log(`\nReady to publish: ${tarball}`);
} catch {
    // Remove a tarball that did not pass, so it cannot be published by mistake.
    rmSync(tarball, { force: true });
    console.error('\nrelease:pack failed. Do not publish.');
    process.exitCode = 1;
} finally {
    if (existsSync('base.README.md')) {
        run('npm', ['run', 'use:baseReadme']);
    }
}
