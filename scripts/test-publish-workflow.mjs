#!/usr/bin/env node
// Evaluates the job and step conditions of .github/workflows/publish.yml for a set of events, so that a manual run, a
// fork, or a release with a tag other than ably-echo-<version> can never reach the publish job:
//
//   node scripts/test-publish-workflow.mjs   (also run by scripts/test-release-lib.sh)
//
// The evaluator covers only what the conditions use: context paths, 'strings', ==, !=, &&, ||, !, parentheses and
// startsWith() (case-insensitive, as in GitHub Actions). A condition using anything else fails the test.
// scripts/ has no @types/node, so type-aware lint sees Node's built-ins as untyped. Plain Node, no TypeScript:
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(
    join(ROOT, ".github/workflows/publish.yml"),
    "utf8",
).split("\n");

/** @type {string[]} */
const failures = [];
/** @param {string} name @param {boolean} ok */
const check = (name, ok) => {
    process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${name}\n`);
    if (!ok) {
        failures.push(name);
    }
};

/**
 * The value of the first `<key>: <value>` line after the line matching `start`, at the given indentation.
 * @param {RegExp} start
 * @param {string} key
 * @param {string} indent
 * @returns {string | undefined}
 */
function valueAfter(start, key, indent) {
    const from = lines.findIndex((line) => start.test(line));
    if (from === -1) {
        return undefined;
    }
    const prefix = `${indent}${key}: `;
    return lines
        .slice(from + 1)
        .find((line) => line.startsWith(prefix))
        ?.slice(prefix.length)
        .trim();
}

/**
 * Evaluates a GitHub Actions condition against a flat context such as { "github.event_name": "release" }.
 * @param {string} expression
 * @param {Record<string, string | boolean | null>} context
 * @returns {boolean}
 */
function evaluate(expression, context) {
    /** @type {string[]} */
    const strings = [];
    const js = expression
        .replace(/'([^']*)'/g, (_, text) => {
            strings.push(String(text));
            return `__s${strings.length - 1}`;
        })
        .replace(/\bstartsWith\(/g, "__startsWith(")
        .replace(
            /\b(github|needs|matrix|steps|env|inputs)(\.[\w-]+)+/g,
            (path) => `__ctx(${JSON.stringify(path)})`,
        )
        .replace(/__s(\d+)/g, (_, index) =>
            JSON.stringify(strings[Number(index)]),
        )
        .replace(/==/g, "===")
        .replace(/!=/g, "!==");
    const unknown = js.replace(
        /"[^"]*"|__ctx|__startsWith|===|!==|&&|\|\||[!(),\s]/g,
        "",
    );
    if (unknown !== "") {
        throw new Error(
            `Unsupported condition syntax in ${expression}: ${unknown}`,
        );
    }
    /** @param {string} path */
    const ctx = (path) => context[path] ?? null;
    /** @param {string | boolean | null} text @param {string | boolean | null} prefix */
    const startsWith = (text, prefix) =>
        `${text ?? ""}`
            .toLowerCase()
            .startsWith(`${prefix ?? ""}`.toLowerCase());
    const condition =
        /** @type {(c: typeof ctx, s: typeof startsWith) => unknown} */ (
            // The expression is publish.yml's own condition, translated above; nothing else is evaluated.
            // oxlint-disable-next-line typescript/no-implied-eval
            new Function("__ctx", "__startsWith", `return (${js});`)
        );
    return Boolean(condition(ctx, startsWith));
}

const publishIf = valueAfter(/^  publish:$/, "if", "    ");
const guardIf = valueAfter(/^ +id: guard$/, "if", "        ");
check("the publish job has a condition", publishIf !== undefined);
check("the release guard step has a condition", guardIf !== undefined);

/** @param {string | null} eventName @param {string | null} tag @param {string} repository */
const event = (eventName, tag, repository = "ably-forks/laravel-echo") => ({
    "github.event_name": eventName,
    "github.repository": repository,
    "github.event.release.tag_name": tag,
});

const scenarios = [
    {
        name: "release ably-echo-2.0.0",
        context: event("release", "ably-echo-2.0.0"),
        publish: true,
        guard: true,
    },
    {
        name: "prerelease ably-echo-2.0.0-rc.0",
        context: event("release", "ably-echo-2.0.0-rc.0"),
        publish: true,
        guard: true,
    },
    {
        name: "manual run (workflow_dispatch)",
        context: event("workflow_dispatch", null),
        publish: false,
        guard: false,
    },
    // The guard step still runs, and fails the verify job.
    {
        name: "release with tag v2.0.0",
        context: event("release", "v2.0.0"),
        publish: false,
        guard: true,
    },
    {
        name: "release with tag 2.0.0",
        context: event("release", "2.0.0"),
        publish: false,
        guard: true,
    },
    {
        name: "release in a fork",
        context: event("release", "ably-echo-2.0.0", "someone/laravel-echo"),
        publish: false,
        guard: true,
    },
];
for (const scenario of scenarios) {
    if (publishIf !== undefined) {
        check(
            `${scenario.name}: publish job ${scenario.publish ? "runs" : "does not run"}`,
            evaluate(publishIf, scenario.context) === scenario.publish,
        );
    }
    if (guardIf !== undefined) {
        check(
            `${scenario.name}: release guard ${scenario.guard ? "runs" : "is skipped"}`,
            evaluate(guardIf, scenario.context) === scenario.guard,
        );
    }
}

const text = lines.join("\n");
const publishJob = text.slice(text.indexOf("\n  publish:\n"));
check(
    "triggers: release published and workflow_dispatch",
    /\n {2}release:\n(?: +#.*\n)* +types: \[published\]\n {2}workflow_dispatch:\n/.test(
        text,
    ),
);
check("the publish job needs verify", /\n {4}needs: verify\n/.test(publishJob));
check(
    "id-token: write appears once, in the publish job",
    (text.match(/id-token: write/g) ?? []).length === 1 &&
        publishJob.includes("id-token: write"),
);
check(
    "the dist-tag and version come from the release guard",
    publishJob.includes("DIST_TAG: ${{ needs.verify.outputs.dist_tag }}") &&
        publishJob.includes("VERSION: ${{ needs.verify.outputs.version }}"),
);
check(
    "verify exports the guard's outputs",
    text.includes("version: ${{ steps.guard.outputs.version }}") &&
        text.includes("dist_tag: ${{ steps.guard.outputs.dist_tag }}"),
);

if (failures.length > 0) {
    process.stderr.write(`${failures.length} publish.yml check(s) failed.\n`);
    process.exit(1);
}
process.stdout.write("All publish.yml condition checks passed.\n");
