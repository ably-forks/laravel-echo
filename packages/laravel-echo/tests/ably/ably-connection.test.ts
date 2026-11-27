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
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });
describe("AblyConnection", () => {
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
        // Each test registers its connection listener first and then calls connect(): with autoConnect the
        // initialized -> connecting event can be emitted before the test body runs (it is on the browser build).
        echo = new Echo({
            broadcaster: "ably",
            useTls: true,
            endpoint: "nonprod:sandbox",
            requestTokenFn: mockAuthServer.getSignedToken,
            autoConnect: false,
        });
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            if (echo.connector.ably.connection.state === "closed") {
                resolve();
            } else {
                echo.disconnect();
                echo.connector.ably.connection.once("closed", () => {
                    resolve();
                });
            }
        });
    });

    test("should be able to connect to server", () =>
        new Promise<void>((resolve, reject) => {
            expect.assertions(3);
            echo.connector.ably.connection.on(
                ({ current, previous, reason }) => {
                    if (current == "connecting") {
                        safeAssert(() => expect(previous).toBe("initialized"), {
                            resolve,
                            reject,
                        });
                    } else if (current == "connected") {
                        safeAssert(
                            () => {
                                expect(previous).toBe("connecting");
                                expect(typeof echo.socketId()).toBe("string");
                            },
                            { resolve, reject },
                        );
                        // Added timeout to make sure connection stays active
                        setTimeout(() => {
                            echo.connector.ably.connection.off();
                            resolve();
                        }, 3000);
                    } else if (reason) {
                        reject(reason);
                        return;
                    }
                },
            );
            echo.connector.ably.connect();
        }));

    test("should be able to disconnect from server", () =>
        new Promise<void>((resolve, reject) => {
            expect.assertions(4);
            echo.connector.ably.connection.on(
                ({ current, previous, reason }) => {
                    if (current == "connecting") {
                        safeAssert(() => expect(previous).toBe("initialized"), {
                            resolve,
                            reject,
                        });
                    } else if (current == "connected") {
                        safeAssert(() => expect(previous).toBe("connecting"), {
                            resolve,
                            reject,
                        });
                        echo.disconnect();
                    } else if (current == "closing") {
                        safeAssert(() => expect(previous).toBe("connected"), {
                            resolve,
                            reject,
                        });
                    } else if (current == "closed") {
                        safeAssert(() => expect(previous).toBe("closing"), {
                            resolve,
                            reject,
                        });
                        echo.connector.ably.connection.off();
                        resolve();
                    } else if (reason) {
                        reject(reason);
                        return;
                    }
                },
            );
            echo.connector.ably.connect();
        }));
});
