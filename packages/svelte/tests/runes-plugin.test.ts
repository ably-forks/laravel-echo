// @vitest-environment node
/**
 * The build's runes plugin (fork, F-078): a module with runes that fail to compile fails the build, instead of
 * shipping its uncompiled rune calls. Modules without runes are left to the normal pipeline.
 */
/// <reference types="node" />
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { svelteRunesTsPlugin } from "../vite.config";

type Transform = (code: string, id: string) => Promise<{ code: string } | null>;

const srcFile = (name: string) =>
    resolve(dirname(fileURLToPath(import.meta.url)), "../src", name);

const transform = (code: string, id: string) =>
    (svelteRunesTsPlugin() as unknown as { transform: Transform }).transform(
        code,
        id,
    );

// built from parts so that this test file itself has no rune for the plugin to compile
const rune = (name: string) => `$${name}`;

describe("svelte runes plugin (F-078)", () => {
    it("compiles the runes of a TypeScript module", async () => {
        const result = await transform(
            `export const counter = () => { let count = ${rune("state")}<number>(0); return () => count; };`,
            srcFile("counter.ts"),
        );

        expect(result?.code).toContain("svelte/internal/client");
        expect(result?.code).not.toContain(`${rune("state")}<`);
        expect(result?.code).not.toContain(`${rune("state")}(`);
    });

    it("leaves a module without runes alone", async () => {
        await expect(
            transform("export const one = 1;", srcFile("plain.ts")),
        ).resolves.toBeNull();
    });

    it("fails, naming the file, when the runes do not compile", async () => {
        const id = srcFile("broken.ts");

        // a rune that is not a variable initialiser is a Svelte compile error (state_invalid_placement)
        const result = transform(
            `export const value = String(${rune("state")}(1));`,
            id,
        );

        await expect(result).rejects.toThrow(
            `[svelte runes] failed to compile ${id}: `,
        );
        await expect(result).rejects.toThrow(/state_invalid_placement/);
    });
});
