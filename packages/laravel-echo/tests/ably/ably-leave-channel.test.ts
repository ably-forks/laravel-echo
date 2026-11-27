import {
    vi,
    describe,
    test,
    expect,
    beforeEach,
    afterEach,
    beforeAll,
    afterAll,
} from "vite-plus/test";
/**
 * UC-02 / P-04 on a live connection: Echo.leaveChannel(name, visibility) leaves only the channel of that visibility.
 * Its Ably channel `${visibility}:${name}` detaches and leaves `connector.channels`, while the siblings with the same
 * name and another visibility stay attached and keep receiving messages. Sandbox app per suite; no keys needed.
 */
import { setup, tearDown } from "./setup/sandbox";
import Echo from "../../src/echo";
import { MockAuthServer } from "./setup/mock-auth-server";
import type { ChannelVisibility } from "../../src/echo";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

let channelCounter = 0;
// unique per test and per run, so an earlier test's channel state cannot leak into the next one
const uniqueChannel = (label: string) =>
    `${label}-${Date.now()}-${++channelCounter}`;

// leaveChannel() calls channel.off() before detach(), so wait on the state rather than on a listener added earlier
const whenDetached = (channel: any) =>
    channel.state === "detached"
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
              channel.once("detached", () => resolve()),
          );

describe("Echo.leaveChannel(name, visibility) with the Ably connector (live)", () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echo: Echo<"ably">;

    beforeAll(async () => {
        testApp = await setup();
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
    });

    afterAll(async () => {
        return await tearDown(testApp);
    });

    beforeEach(() => {
        echo = new Echo({
            broadcaster: "ably",
            useTls: true,
            endpoint: "nonprod:sandbox",
            requestTokenFn: mockAuthServer.getSignedToken,
        });
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            echo.disconnect();
            echo.connector.ably.connection.once("closed", () => {
                resolve();
            });
        });
    });

    /** Subscribes the same name with all three visibilities and waits until each is attached. */
    const joinAll = async (name: string) => {
        const channels = {
            public: echo.channel(name),
            private: echo.private(name),
            presence: echo.join(name),
        };
        await Promise.all(
            Object.values(channels).map(
                (channel) =>
                    new Promise((resolve) => channel.subscribed(resolve)),
            ),
        );
        return channels;
    };

    test.each<ChannelVisibility>(["private", "presence", "public"])(
        'leaveChannel(name, "%s") detaches only that channel; the siblings stay attached and receive messages',
        async (visibility) => {
            const name = uniqueChannel(`leave-${visibility}`);
            const channels = await joinAll(name);
            const left = channels[visibility].channel;
            const siblings = (
                ["public", "private", "presence"] as const
            ).filter((v) => v !== visibility);

            echo.leaveChannel(name, visibility);

            await whenDetached(left);
            expect(left.state).toBe("detached");
            expect(Object.keys(echo.connector.channels).sort()).toEqual(
                siblings.map((v) => `${v}:${name}`).sort(),
            );
            siblings.forEach((v) =>
                expect(channels[v].channel.state).toBe("attached"),
            );

            // a sibling still gets its messages after the leave
            const sibling = siblings[0];
            const received = new Promise((resolve) =>
                channels[sibling].listen(".afterLeave", resolve),
            );
            await mockAuthServer.broadcast(
                `${sibling}:${name}`,
                "afterLeave",
                "still here",
            );
            await expect(received).resolves.toBe("still here");
        },
    );

    test("leaveChannel(name) without a visibility still takes the full Ably name", async () => {
        const name = uniqueChannel("leave-full-name");
        const channels = await joinAll(name);

        echo.leaveChannel(`private:${name}`);

        await whenDetached(channels.private.channel);
        expect(Object.keys(echo.connector.channels).sort()).toEqual([
            `presence:${name}`,
            `public:${name}`,
        ]);
        expect(channels.public.channel.state).toBe("attached");
        expect(channels.presence.channel.state).toBe("attached");
    });
});
