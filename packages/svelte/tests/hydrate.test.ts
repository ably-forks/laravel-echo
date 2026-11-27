/**
 * Hydration after a server render (fork, P-09): the server output has no subscription, and hydrating it in the
 * browser subscribes each channel exactly once, as a client-only mount does (upstream behaviour).
 */
/// <reference types="node" />
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { render } from "svelte/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { compileFixture } from "./ssr-fixture";

// "svelte" resolves to its server entry under Vitest, where hydrate() is unavailable: load the browser entry
const svelteClient = async () =>
    (await import(
        /* @vite-ignore */ pathToFileURL(
            join(
                dirname(
                    createRequire(import.meta.url).resolve(
                        "svelte/package.json",
                    ),
                ),
                "src/index-client.js",
            ),
        ).href
    )) as typeof import("svelte");

const { echoInstances } = vi.hoisted(() => ({
    echoInstances: [] as any[],
}));

vi.mock("@ably/laravel-echo", () => {
    const channel = () => ({
        listen: vi.fn(),
        stopListening: vi.fn(),
        notification: vi.fn(),
        stopListeningForNotification: vi.fn(),
    });

    const Echo = vi.fn(function (options: unknown) {
        const instance = {
            options,
            private: vi.fn(() => channel()),
            channel: vi.fn(() => channel()),
            join: vi.fn(() => channel()),
            leave: vi.fn(),
            leaveChannel: vi.fn(),
            leaveAllChannels: vi.fn(),
            connectionStatus: vi.fn(() => "connected"),
            socketId: vi.fn(() => "socket-1"),
            onConnectionChange: vi.fn(() => vi.fn()),
        };

        echoInstances.push(instance);

        return instance;
    });

    return { default: Echo };
});

describe("hydration after server rendering (P-09)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        echoInstances.length = 0;
        document.body.innerHTML = "";
    });

    it("subscribes each channel exactly once when the server output hydrates", async () => {
        const { flushSync, hydrate, unmount } = await svelteClient();
        const { configureEcho } = await import("../src");

        configureEcho({ broadcaster: "ably" });

        // the server render: no window, as under svelte/server in Node
        vi.stubGlobal("window", undefined);
        expect(typeof window).toBe("undefined");

        const { default: ServerFixture } = await compileFixture("server");
        const { body } = render(ServerFixture);

        vi.unstubAllGlobals();
        expect(echoInstances).toHaveLength(0);
        expect(body).toContain("disconnected");

        // the browser: hydrate the server output
        document.body.innerHTML = body;

        const { default: ClientFixture } = await compileFixture("client");
        const component = hydrate(ClientFixture, { target: document.body });

        flushSync();

        expect(echoInstances).toHaveLength(1);

        const [instance] = echoInstances;

        expect(document.querySelector("#status")?.textContent).toBe(
            "connected",
        );
        expect(document.querySelector("#socket")?.textContent).toBe("socket-1");
        expect(document.querySelector("#channel")?.textContent).toBe("channel");

        // useEcho, useEchoNotification + useEchoModel (one private channel) and useChannel
        expect(instance.private.mock.calls).toEqual([
            ["orders"],
            ["App.Models.User.1"],
            ["account"],
        ]);
        expect(instance.channel.mock.calls).toEqual([["posts"], ["news"]]);
        expect(instance.join.mock.calls).toEqual([["room"], ["lobby"]]);
        // useConnectionStatus and useSocketId
        expect(instance.onConnectionChange).toHaveBeenCalledTimes(2);

        // one registry count per hook: unmounting leaves every channel once
        await unmount(component);
        flushSync();

        expect(instance.leaveChannel).toHaveBeenCalledTimes(7);
        expect(instance.leaveChannel.mock.calls).toEqual(
            expect.arrayContaining([
                ["App.Models.User.1", "private"],
                ["account", "private"],
                ["lobby", "presence"],
                ["news", "public"],
                ["orders", "private"],
                ["posts", "public"],
                ["room", "presence"],
            ]),
        );
    });
});
