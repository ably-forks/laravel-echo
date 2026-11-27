/// <reference types="node" />
/**
 * A component that calls every rune, compiled the way an app's Svelte build compiles it (fork, P-09): the package
 * has no Svelte Vite plugin, so the tests compile it explicitly and import the output from a temporary file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Component } from "svelte";
import { compile } from "svelte/compiler";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcIndex = resolve(packageDir, "src/index.ts");
// inside the package (Vitest serves and transforms it, so its mocks apply) and git-ignored
const fixturesDir = resolve(packageDir, ".vitest");

const source = `
<script>
    import {
        useChannel,
        useConnectionStatus,
        useEcho,
        useEchoModel,
        useEchoNotification,
        useEchoPresence,
        useEchoPublic,
        usePresenceChannel,
        usePublicChannel,
        useSocketId,
    } from ${JSON.stringify(srcIndex)};

    const status = useConnectionStatus();
    const socketId = useSocketId();
    const orders = useEcho("orders", ".OrderShipped", () => {});

    useEchoPublic("posts", ".PostPublished", () => {});
    useEchoPresence("room", ".Joined", () => {});
    useEchoNotification("App.Models.User.1", () => {});
    useEchoModel("App.Models.User", 1, ["UserUpdated"], () => {});
    useChannel("account");
    usePresenceChannel("lobby");
    usePublicChannel("news");
</script>

<p id="status">{status()}</p>
<p id="socket">{socketId() ?? "no-socket"}</p>
<p id="channel">{orders.channel() === null ? "no-channel" : "channel"}</p>
`;

export type FixtureModule = { default: Component };

export const compileFixture = async (
    generate: "server" | "client",
): Promise<FixtureModule> => {
    const { js } = compile(source, {
        filename: "EchoFixture.svelte",
        generate,
    });
    mkdirSync(fixturesDir, { recursive: true });

    const dir = mkdtempSync(join(fixturesDir, "ssr-fixture-"));
    const file = join(dir, `EchoFixture.${generate}.js`);

    writeFileSync(file, js.code);

    try {
        return (await import(
            /* @vite-ignore */ pathToFileURL(file).href
        )) as FixtureModule;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};
