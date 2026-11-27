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
import Echo, { type ConnectionStatus } from "../../src/echo";
import { MockAuthServer } from "./setup/mock-auth-server";
import safeAssert from "./setup/utils";
import { fromBase64UrlEncoded } from "../../src/channel/ably/utils";
import waitForExpect from "wait-for-expect";
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

    /*
     * Phase 06 (P-01, P-03; provisional): the status API on a real connection. Each callback also samples
     * echo.connectionStatus(), which must agree with what is emitted.
     */
    const recordStatus = () => {
        const seen: ConnectionStatus[] = [];
        const sampled: ConnectionStatus[] = [];
        const off = echo.onConnectionChange((status) => {
            seen.push(status);
            sampled.push(echo.connectionStatus());
        });
        return { seen, sampled, off };
    };

    test("Echo.onConnectionChange() fires on connect and on disconnect, and survives Echo.connect()", async () => {
        expect(echo.connectionStatus()).toBe("disconnected"); // autoConnect: false
        const { seen, sampled } = recordStatus();

        echo.connector.ably.connect();
        await waitForExpect(() =>
            expect(seen).toEqual(["connecting", "connected"]),
        );

        echo.disconnect();
        await waitForExpect(() =>
            expect(seen).toEqual(["connecting", "connected", "disconnected"]),
        );
        expect(echo.connectionStatus()).toBe("disconnected");

        const previous = echo.connector;
        echo.connect(); // replaces the connector: one emission with the new connector's status
        expect(echo.connector).not.toBe(previous);
        expect(seen).toEqual([
            "connecting",
            "connected",
            "disconnected",
            "disconnected",
        ]);
        echo.connector.ably.connect();
        await waitForExpect(() =>
            expect(seen.slice(4)).toEqual(["connecting", "connected"]),
        );
        expect(sampled).toEqual(seen);
    });

    test("socketId() is undefined before the connection is up, then base64url JSON with the connection key", async () => {
        expect(echo.socketId()).toBeUndefined();
        const { seen } = recordStatus();
        echo.connector.ably.connect();
        await waitForExpect(() => expect(seen).toContain("connected"));

        const socketId = echo.socketId()!;
        expect(socketId).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(JSON.parse(fromBase64UrlEncoded(socketId))).toEqual({
            connectionKey: echo.connector.ably.connection.key,
            clientId: mockAuthServer.clientId,
        });
    });

    test("a guest-to-user login never reports failed and ends connected", async () => {
        const user = mockAuthServer.clientId;
        mockAuthServer.clientId = null; // a guest: like laravel-broadcaster 2.0, the mock signs it with a guest: id
        mockAuthServer.resetSession();
        try {
            const { seen, sampled } = recordStatus();
            const states: string[] = [];
            echo.connector.ably.connection.on(({ current }) =>
                states.push(current),
            );
            echo.connector.ably.connect();
            await waitForExpect(() =>
                expect(seen).toEqual(["connecting", "connected"]),
            );
            const guestId = echo.connector.ably.auth.clientId;
            expect(guestId).toMatch(/^guest:/);
            expect(guestId).toBe(mockAuthServer.guestId);
            const guestSocketId = echo.socketId();

            mockAuthServer.clientId = user; // the user logs in: the next token carries their clientId
            const privateChannel = echo.private("status-login");
            await new Promise((resolve) => privateChannel.subscribed(resolve));
            await waitForExpect(() => {
                expect(echo.connector.ably.connection.state).toBe("connected");
                expect(seen[seen.length - 1]).toBe("connected");
            });

            expect(states).toContain("failed"); // ably did fail the connection with 40102 (Echo reconnected)
            expect(seen).not.toContain("failed");
            expect(sampled).not.toContain("failed");
            expect(seen).toEqual([
                "connecting",
                "connected",
                "reconnecting",
                "connected",
            ]);
            expect(echo.socketId()).not.toBe(guestSocketId);
            expect(echo.connector.ably.auth.clientId).toBe(user); // guest: id -> user, not null -> user
        } finally {
            mockAuthServer.clientId = user;
        }
    });
});
