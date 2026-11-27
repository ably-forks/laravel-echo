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
import safeAssert from "./setup/utils";
import { AblyChannel, AblyPrivateChannel } from "../../src/channel";

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });
describe("AblyPrivateChannel", () => {
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
        mockAuthServer.renewalMode = "reverify"; // the default; individual tests opt into 'reuse'
        echo = new Echo({
            broadcaster: "ably",
            useTls: true,
            endpoint: "nonprod:sandbox",
            requestTokenFn: mockAuthServer.getSignedToken,
            echoMessages: true, // https://docs.ably.io/client-lib-development-guide/features/#TO3h
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

    test("channel subscription", () =>
        new Promise<void>((resolve) => {
            const privateChannel = echo.private("test") as AblyChannel;
            privateChannel.subscribed(() => {
                privateChannel.unregisterSubscribed();
                resolve();
            });
        }));

    test("Whisper and listen to it", () =>
        new Promise<void>((resolve, reject) => {
            const privateChannel = echo.private("test") as AblyPrivateChannel;
            privateChannel
                .subscribed(() => {
                    // a string payload: Ably whispers any data, though the upstream signature types it as a Record
                    privateChannel.whisper(
                        "msg",
                        "Hello there jonny!" as unknown as Record<
                            string,
                            unknown
                        >,
                    );
                })
                .listenForWhisper("msg", (data: unknown) => {
                    safeAssert(
                        () => expect(data).toBe("Hello there jonny!"),
                        { resolve, reject },
                        true,
                    );
                });
        }));

    test("channel subscription error, token expired", () =>
        new Promise<void>((resolve, reject) => {
            // The 3 s channel token must stay expired for the test to see an error. On a connection renewal ('reverify', the
            // default) the mock issues a fresh full-length token and drops the short-lived exp, so no error would ever occur;
            // 'reuse' (old broadcaster) returns the same iat/exp, so the 3 s token expires inside Ably's 30 s re-auth window.
            mockAuthServer.renewalMode = "reuse";
            mockAuthServer.setAuthExceptions(["private:shortLivedChannel"]);
            const privateChannel = echo.private(
                "shortLivedChannel",
            ) as AblyChannel;
            privateChannel.error((stateChangeError: unknown) => {
                privateChannel.unregisterError();
                safeAssert(
                    () => expect(stateChangeError).toBeTruthy(),
                    { resolve, reject },
                    true,
                );
            });
        }));

    test("channel subscription error, access denied", () =>
        new Promise<void>((resolve, reject) => {
            mockAuthServer.setAuthExceptions([], ["private:bannedChannel"]);
            const privateChannel = echo.private("bannedChannel") as AblyChannel;
            privateChannel.error((stateChangeError: unknown) => {
                privateChannel.unregisterError();
                safeAssert(
                    () => expect(stateChangeError).toBeTruthy(),
                    { resolve, reject },
                    true,
                );
            });
        }));
});
