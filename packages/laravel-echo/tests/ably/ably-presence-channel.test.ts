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
import { setup, tearDown } from "./setup/sandbox";
import Echo from "../../src/echo";
import { MockAuthServer } from "./setup/mock-auth-server";
import { AblyPresenceChannel } from "../../src/channel";
import safeAssert, {
    closeConnection,
    waitWithDiagnostics,
} from "./setup/utils";
import type { PresenceMessage } from "../../src/types/ably";

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

let channelCounter = 0;
// Unique per test and per run: a previous test's connection may still be a member of a shared channel for a moment.
const uniqueChannel = (label: string) =>
    `${label}-${Date.now()}-${++channelCounter}`;

describe("AblyPresenceChannel", () => {
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

    afterEach(() => closeConnection(echo));

    test("channel subscription", ({ task }) => {
        const presenceChannel = echo.join(
            uniqueChannel("subscription"),
        ) as AblyPresenceChannel;
        return waitWithDiagnostics(
            new Promise<void>((resolve) => {
                presenceChannel.subscribed(() => {
                    presenceChannel.unregisterSubscribed();
                    resolve();
                });
            }),
            "the presence channel to be subscribed",
            task,
            echo,
            presenceChannel,
        );
    });

    test("channel member list change", ({ task }) => {
        const presenceChannel = echo.join(
            uniqueChannel("list"),
        ) as AblyPresenceChannel;
        return waitWithDiagnostics(
            new Promise<void>((resolve, reject) => {
                presenceChannel.here(
                    (
                        members: Array<{ id: string; name: string }>,
                        err: unknown,
                    ) => {
                        safeAssert(
                            () => {
                                expect(err).toBeFalsy();
                                expect(members).toHaveLength(1);
                                expect(members[0].id).toBe("sacOO7@github.com");
                                expect(members[0].name).toBe("sacOO7");
                                expect(members[0]).toStrictEqual({
                                    id: "sacOO7@github.com",
                                    name: "sacOO7",
                                });
                            },
                            { resolve, reject },
                            true,
                        );
                    },
                );
            }),
            "here() with the member list",
            task,
            echo,
            presenceChannel,
        );
    });

    test("member joined", ({ task }) => {
        const presenceChannel = echo.join(
            uniqueChannel("joined"),
        ) as AblyPresenceChannel;
        return waitWithDiagnostics(
            new Promise<void>((resolve, reject) => {
                presenceChannel.joining(
                    (
                        memberData: unknown,
                        memberMetaData: Omit<PresenceMessage, "data">,
                    ) => {
                        safeAssert(
                            () => {
                                expect(memberData).toStrictEqual({
                                    id: "sacOO7@github.com",
                                    name: "sacOO7",
                                });
                                expect(memberMetaData.clientId).toBe(
                                    "sacOO7@github.com",
                                );
                            },
                            { resolve, reject },
                            true,
                        );
                    },
                );
            }),
            "the joining event",
            task,
            echo,
            presenceChannel,
        );
    });

    test("member left", ({ task }) => {
        const presenceChannel = echo.join(
            uniqueChannel("left"),
        ) as AblyPresenceChannel;
        return waitWithDiagnostics(
            new Promise<void>((resolve, reject) => {
                presenceChannel.leaving(
                    (
                        memberData: unknown,
                        memberMetaData: Omit<PresenceMessage, "data">,
                    ) => {
                        safeAssert(
                            () => {
                                expect(memberData).toStrictEqual({
                                    name: "sacOO7 leaving the channel",
                                });
                                expect(memberMetaData.clientId).toBe(
                                    "sacOO7@github.com",
                                );
                            },
                            { resolve, reject },
                            true,
                        );
                    },
                );
                presenceChannel.joining(() =>
                    presenceChannel.leave({
                        name: "sacOO7 leaving the channel",
                    }),
                );
            }),
            "the leaving event",
            task,
            echo,
            presenceChannel,
        );
    });
});
