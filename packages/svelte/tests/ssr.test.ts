// @vitest-environment node
/**
 * Server rendering (fork, P-09): the runes ship compiled for the client, so during svelte/server's render() they
 * must neither create Echo (no Ably connection), nor subscribe, nor run $effect (effect_orphan), nor touch window.
 */
import { render } from "svelte/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { compileFixture } from "./ssr-fixture";

vi.mock("@ably/laravel-echo", () => ({
    default: vi.fn(function () {
        throw new Error("Echo must not be created during server rendering");
    }),
}));

describe("server rendering (P-09)", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("renders every rune without configureEcho()", async () => {
        expect(typeof window).toBe("undefined");

        const { default: Fixture } = await compileFixture("server");
        const { body } = render(Fixture);

        expect(body).toContain(`<p id="status">disconnected</p>`);
        expect(body).toContain(`<p id="socket">no-socket</p>`);
        expect(body).toContain(`<p id="channel">no-channel</p>`);

        const Echo = (await import("@ably/laravel-echo")).default;

        expect(Echo).not.toHaveBeenCalled();
        expect("window" in globalThis).toBe(false);
    });

    it("does not create Echo when configureEcho() ran on the server", async () => {
        const { configureEcho, echoIsConfigured } = await import("../src");

        configureEcho({ broadcaster: "ably" });
        expect(echoIsConfigured()).toBe(true);

        const { default: Fixture } = await compileFixture("server");
        const { body } = render(Fixture);

        expect(body).toContain(`<p id="status">disconnected</p>`);
        expect(body).toContain(`<p id="socket">no-socket</p>`);
        expect(body).toContain(`<p id="channel">no-channel</p>`);

        const Echo = (await import("@ably/laravel-echo")).default;

        expect(Echo).not.toHaveBeenCalled();
        expect("window" in globalThis).toBe(false);
    });
});
