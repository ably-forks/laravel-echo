/**
 * The hooks' leave by name and visibility (fork, P-04) with a non-Ably connector: the real core and the Mercure
 * connector, whose channel names are Pusher-style ("private-orders"). Echo.connectorChannelName() cannot express
 * Mercure's "private-encrypted-" names (VC-07), which no hook uses. Network access is stubbed.
 */
import { renderHook } from "@testing-library/react";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";

const getModule = async () => import("../src/index");

describe("hooks with the Mercure connector", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal(
            "fetch",
            vi.fn(() => new Promise(() => {})),
        );
        vi.stubGlobal(
            "EventSource",
            vi.fn(function (this: Record<string, unknown>) {
                this.close = vi.fn();
                this.addEventListener = vi.fn();
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        ["useEcho", "private-orders"],
        ["useEchoPresence", "presence-orders"],
        ["useEchoPublic", "orders"],
    ] as const)("%s subscribes and leaves %s", async (hook, connectorName) => {
        const module = await getModule();

        module.configureEcho({
            broadcaster: "mercure",
            host: "https://hub.test/.well-known/mercure",
            withoutInterceptors: true,
        });

        const useHook = module[hook] as (
            channelName: string,
            event: string,
            callback: () => void,
        ) => unknown;

        const { unmount } = renderHook(() =>
            useHook("orders", ".OrderShipped", () => {}),
        );
        const channels = () =>
            Object.keys(
                (module.echo() as { connector: { channels: object } }).connector
                    .channels,
            );

        expect(channels()).toEqual([connectorName]);

        unmount();

        expect(channels()).toEqual([]);
    });
});
