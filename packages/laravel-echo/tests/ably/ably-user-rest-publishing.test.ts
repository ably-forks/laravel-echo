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
import { closeConnection } from "./setup/utils";
import { AblyChannel, AblyPrivateChannel } from "../../src/channel";
import waitForExpect from "wait-for-expect";
import { fromBase64UrlEncoded } from "../../src/channel/ably/utils";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
describe("AblyUserRestPublishing", () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echoInstances: Array<Echo<"ably">>;

    beforeAll(async () => {
        testApp = await setup();
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
    });

    afterAll(async () => {
        return await tearDown(testApp);
    });

    beforeEach(() => {
        echoInstances = [];
    });

    afterEach(async () => {
        await Promise.all(echoInstances.map(closeConnection));
    });

    async function getGuestUserChannel(channelName: string) {
        mockAuthServer.clientId = null;
        mockAuthServer.resetSession(); // each guest is another visitor, with its own guest id
        const guestUser = new Echo({
            broadcaster: "ably",
            useTls: true,
            endpoint: "nonprod:sandbox",
            requestTokenFn: mockAuthServer.getSignedToken,
        });
        echoInstances.push(guestUser);
        const publicChannel = guestUser.channel(channelName) as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        // laravel-broadcaster v2 always issues a guest client id
        expect(guestUser.connector.ably.auth.clientId).toMatch(/^guest:/);
        expect(guestUser.connector.ablyAuth!.existingToken()!.clientId).toBe(
            guestUser.connector.ably.auth.clientId,
        );
        return publicChannel;
    }

    async function getLoggedInUserChannel(channelName: string) {
        mockAuthServer.clientId = "sacOO7@github.com";
        const loggedInUser = new Echo({
            broadcaster: "ably",
            useTls: true,
            endpoint: "nonprod:sandbox",
            requestTokenFn: mockAuthServer.getSignedToken,
        });
        echoInstances.push(loggedInUser);
        const privateChannel = loggedInUser.private(
            channelName,
        ) as AblyPrivateChannel;
        await new Promise((resolve) => privateChannel.subscribed(resolve));
        expect(loggedInUser.connector.ably.auth.clientId).toBe(
            "sacOO7@github.com",
        );
        expect(loggedInUser.connector.ablyAuth!.existingToken()!.clientId).toBe(
            "sacOO7@github.com",
        );
        mockAuthServer.clientId = null;
        return privateChannel;
    }

    test("Guest user return socketId as base64 encoded connectionkey and the guest clientId", async () => {
        await getGuestUserChannel("dummyChannel");
        const guestUser = echoInstances[0];
        const socketIdObj = JSON.parse(
            fromBase64UrlEncoded(guestUser.socketId()!),
        );

        const expectedConnectionKey = guestUser.connector.ably.connection.key;

        expect(socketIdObj.connectionKey).toBe(expectedConnectionKey);
        expect(socketIdObj.connectionKey).toBeTruthy();

        // 1.x sent null here; with laravel-broadcaster v2 it is the guest id
        expect(socketIdObj.clientId).toMatch(/^guest:/);
        expect(socketIdObj.clientId).toBe(
            guestUser.connector.ably.auth.clientId,
        );
    });

    test("Guest user publishes message via rest API", async () => {
        let messagesReceived: Array<string> = [];
        const receivedBySender: Array<string> = [];
        const receivedByOther: Array<string> = [];
        let channelName = "testChannel";

        const publicChannel1 = await getGuestUserChannel(channelName);
        publicChannel1.listenToAll((eventName: string, data: unknown) => {
            messagesReceived.push(eventName);
            receivedBySender.push(eventName);
        });

        const publicChannel2 = await getGuestUserChannel(channelName);
        publicChannel2.listenToAll((eventName: string, data: unknown) => {
            messagesReceived.push(eventName);
            receivedByOther.push(eventName);
        });

        // Publish message to all clients
        await mockAuthServer.broadcast(
            `public:${channelName}`,
            "testEvent",
            "mydata",
        );
        await waitForExpect(() => {
            expect(messagesReceived.length).toBe(2);
            expect(
                messagesReceived.filter((m) => m == ".testEvent").length,
            ).toBe(2);
        });

        // Publish message to other client
        messagesReceived = [];
        const firstClientSocketId = echoInstances[0].socketId()!;
        await mockAuthServer.broadcastToOthers(firstClientSocketId, {
            channelName: `public:${channelName}`,
            eventName: "toOthers",
            payload: "data",
        });
        await waitForExpect(() => {
            expect(messagesReceived.length).toBe(1);
            expect(
                messagesReceived.filter((m) => m == ".toOthers").length,
            ).toBe(1);
        });
        // toOthers excludes the sender's connection (connectionKey, echoMessages: false), whatever its guest clientId
        expect(receivedByOther).toContain(".toOthers");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(receivedBySender).not.toContain(".toOthers");
    });

    test("Logged in user return socketId as base64 encoded connectionkey and clientId", async () => {
        await getLoggedInUserChannel("dummyChannel");
        const loggedInUser = echoInstances[0];
        const socketIdObj = JSON.parse(
            fromBase64UrlEncoded(loggedInUser.socketId()!),
        );

        const expectedConnectionKey =
            loggedInUser.connector.ably.connection.key;

        expect(socketIdObj.connectionKey).toBe(expectedConnectionKey);
        expect(socketIdObj.connectionKey).toBeTruthy();

        expect(socketIdObj.clientId).toBe("sacOO7@github.com");
    });

    test("Logged in user publishes message via rest API", async () => {
        let messagesReceived: Array<string> = [];
        let channelName = "testChannel";

        const privateChannel1 = await getLoggedInUserChannel(channelName);
        privateChannel1.listenToAll((eventName: string, data: unknown) => {
            messagesReceived.push(eventName);
        });

        const privateChannel2 = await getLoggedInUserChannel(channelName);
        privateChannel2.listenToAll((eventName: string, data: unknown) => {
            messagesReceived.push(eventName);
        });

        // Publish message to all clients
        await mockAuthServer.broadcast(
            `private:${channelName}`,
            "testEvent",
            "mydata",
        );
        await waitForExpect(() => {
            expect(messagesReceived.length).toBe(2);
            expect(
                messagesReceived.filter((m) => m == ".testEvent").length,
            ).toBe(2);
        });

        // Publish message to other client
        messagesReceived = [];
        const firstClientSocketId = echoInstances[0].socketId()!;
        await mockAuthServer.broadcastToOthers(firstClientSocketId, {
            channelName: `private:${channelName}`,
            eventName: "toOthers",
            payload: "data",
        });
        await waitForExpect(() => {
            expect(messagesReceived.length).toBe(1);
            expect(
                messagesReceived.filter((m) => m == ".toOthers").length,
            ).toBe(1);
        });
    });
});
