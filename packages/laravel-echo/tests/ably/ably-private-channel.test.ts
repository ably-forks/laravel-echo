import { vi, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vite-plus/test";
import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import safeAssert from './setup/utils';
import { AblyChannel, AblyPrivateChannel } from '../../src/channel';

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });
describe('AblyPrivateChannel', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echo: Echo;

    beforeAll(async () => {
        testApp = await setup();
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
    });

    afterAll(async () => {
        return await tearDown(testApp);
    });

    beforeEach(() => {
        mockAuthServer.renewalMode = 'reverify'; // the default; individual tests opt into 'reuse'
        echo = new Echo({
            broadcaster: 'ably',
            useTls: true,
            endpoint: 'nonprod:sandbox',
            requestTokenFn: mockAuthServer.getSignedToken,
            echoMessages: true, // https://docs.ably.io/client-lib-development-guide/features/#TO3h
        });
    });

    afterEach((done) => {
        echo.disconnect();
        echo.connector.ably.connection.once('closed', () => {
            done();
        });
    });

    test('channel subscription', (done) => {
        const privateChannel = echo.private('test') as AblyChannel;
        privateChannel.subscribed(() => {
            privateChannel.unregisterSubscribed();
            done();
        });
    });

    test('Whisper and listen to it', (done) => {
        const privateChannel = echo.private('test') as AblyPrivateChannel;
        privateChannel
            .subscribed(() => {
                privateChannel.whisper('msg', 'Hello there jonny!');
            })
            .listenForWhisper('msg', (data) => {
                safeAssert(() => expect(data).toBe('Hello there jonny!'), done, true);
            });
    });

    test('channel subscription error, token expired', (done) => {
        // The 3 s channel token must stay expired for the test to see an error. On a connection renewal ('reverify', the
        // default) the mock issues a fresh full-length token and drops the short-lived exp, so no error would ever occur;
        // 'reuse' (old broadcaster) returns the same iat/exp, so the 3 s token expires inside Ably's 30 s re-auth window.
        mockAuthServer.renewalMode = 'reuse';
        mockAuthServer.setAuthExceptions(['private:shortLivedChannel']);
        const privateChannel = echo.private('shortLivedChannel') as AblyChannel;
        privateChannel.error((stateChangeError) => {
            privateChannel.unregisterError();
            safeAssert(() => expect(stateChangeError).toBeTruthy(), done, true);
        });
    });

    test('channel subscription error, access denied', (done) => {
        mockAuthServer.setAuthExceptions([], ['private:bannedChannel']);
        const privateChannel = echo.private('bannedChannel') as AblyChannel;
        privateChannel.error((stateChangeError) => {
            privateChannel.unregisterError();
            safeAssert(() => expect(stateChangeError).toBeTruthy(), done, true);
        });
    });
});
