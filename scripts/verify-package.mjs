#!/usr/bin/env node
/*
 * Verifies a packed @ably/laravel-echo tarball before it is published.
 *
 * Usage: node scripts/verify-package.mjs <package.tgz> <expected-version>
 *
 * Exit codes: 0 all checks passed, 1 at least one check failed (each is named), 2 bad usage or the tarball could not be read.
 * It needs no dependencies, only Node and a `tar` binary, and it does not depend on npm lifecycle
 * scripts (which `ignore-scripts=true` skips), so it can be run by hand or in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [, , tarball, expectedVersion] = process.argv;

if (!tarball || !expectedVersion) {
    console.error('Usage: node scripts/verify-package.mjs <package.tgz> <expected-version>');
    process.exit(2);
}

if (!existsSync(tarball)) {
    console.error(`Tarball not found: ${tarball}`);
    process.exit(2);
}

const MIN_BUNDLE_BYTES = 100000;
const BUNDLES = ['dist/echo.js', 'dist/echo.common.js', 'dist/echo.iife.js'];

const dir = mkdtempSync(join(tmpdir(), 'verify-echo-'));
const failures = [];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`);
    if (!ok) {
        failures.push(name);
    }
};

const read = (path) => (existsSync(join(dir, 'package', path)) ? readFileSync(join(dir, 'package', path), 'utf8') : null);

try {
    try {
        execFileSync('tar', ['-xzf', resolve(tarball), '-C', dir], { stdio: 'pipe' });
    } catch (error) {
        console.error(
            error.code === 'ENOENT'
                ? 'The `tar` command was not found. Install it (it ships with macOS, Linux and recent Windows) and retry.'
                : `Could not extract ${tarball}: ${error.message}`,
        );
        rmSync(dir, { recursive: true, force: true });
        process.exit(2);
    }

    let pkg = {};
    try {
        pkg = JSON.parse(read('package.json') ?? '{}');
    } catch {
        // Leave it empty: the name and version checks below then fail with a clear message.
    }

    check('package.json name is @ably/laravel-echo', pkg.name === '@ably/laravel-echo', pkg.name);
    check(`package.json version is ${expectedVersion}`, pkg.version === expectedVersion, pkg.version);

    const versionPattern = new RegExp(`(?:version|LIB_VERSION) = ["']${escapeRegExp(expectedVersion)}["']`);

    for (const bundle of BUNDLES) {
        const source = read(bundle);

        if (source === null) {
            check(`${bundle} is present`, false, 'missing');
            continue;
        }

        const size = statSync(join(dir, 'package', bundle)).size;
        check(`${bundle} is at least ${MIN_BUNDLE_BYTES} bytes`, size >= MIN_BUNDLE_BYTES, `${size} bytes`);
        check(`${bundle} references @ably/pubsub-device`, source.includes('@ably/pubsub-device'));
        check(`${bundle} has no global Ably.createClient`, !/\bAbly\.createClient\b/.test(source));
        check(`${bundle} embeds version ${expectedVersion}`, versionPattern.test(source));
    }

    // Per-format checks (the same patterns as tests/bundles/built-bundles.test.ts): the ESM and CJS builds keep
    // @ably/pubsub-device external, and the IIFE build bundles its own copy of it.
    const esm = read('dist/echo.js');
    const cjs = read('dist/echo.common.js');
    const iife = read('dist/echo.iife.js');
    check(
        'dist/echo.js imports @ably/pubsub-device as an ES module',
        esm !== null && /^import \* as \w+ from '@ably\/pubsub-device';$/m.test(esm),
    );
    check('dist/echo.js does not bundle the Ably SDK', esm !== null && !/Ably JavaScript Library/.test(esm));
    check('dist/echo.common.js requires @ably/pubsub-device', cjs !== null && /require\('@ably\/pubsub-device'\)/.test(cjs));
    check(
        'dist/echo.iife.js has no ES module imports or require() calls',
        iife !== null && !/\brequire\(|^import /m.test(iife),
    );
    check('dist/echo.iife.js bundles the Ably SDK (v3)', iife !== null && /Ably JavaScript Library v3\./.test(iife));

    const declaration = read('dist/src/connector/ably-connector.d.ts');
    check('dist/src/connector/ably-connector.d.ts references @ably/pubsub-device', declaration?.includes('@ably/pubsub-device') ?? false);

    const readme = read('README.md');
    check(
        'README.md is the Ably README, not the upstream Laravel one',
        readme !== null && readme.includes('@ably/pubsub-device') && !readme.includes('Logo Laravel Echo'),
    );
} finally {
    rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed. Do not publish this tarball.`);
    process.exit(1);
}

console.log('\nAll checks passed.');
