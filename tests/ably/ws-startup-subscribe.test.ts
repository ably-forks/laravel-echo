/**
 * Subscribing a private and a presence channel right at startup, while the connection is still connecting, must not
 * abort and restart the connection attempt: Echo waits for `connected` before its pre-attach authorize() (ably-js
 * RTC8b aborts the attempt that authorize() finds connecting, which cost an extra socket, two CONNECTED sockets for
 * ~250 ms, and a leaked slow-connection timer that later opened a ws-up.ably-realtime.com probe).
 * Own file: jest.mock('ws') applies to the whole file.
 */
// first: it also counts the global WebSocket, which the browser build uses, before ably is loaded
import { connectionIds, recordedSockets, socketsWithConnected, resetRecordedSockets } from './setup/ws-counter';
import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import waitForExpect from 'wait-for-expect';

// eslint-disable-next-line @typescript-eslint/no-var-requires
jest.mock('ws', () => require('./setup/ws-counter').createCountingWs(jest.requireActual('ws')));

jest.setTimeout(60000);

describe('startup subscribe of private and presence channels', () => {
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

    beforeEach(() => resetRecordedSockets());

    afterEach((done) => {
        echo.disconnect();
        echo.connector.ably.connection.once('closed', () => done());
    });

    test('one WebSocket, one connection, no ws-up probe, and both channels attach', async () => {
        echo = new Echo({
            broadcaster: 'ably',
            useTls: true,
            endpoint: 'nonprod:sandbox',
            requestTokenFn: mockAuthServer.getSignedToken,
            useBinaryProtocol: false, // JSON frames, so the test can read them
        } as any);
        const ably = echo.connector.ably;
        expect(['initialized', 'connecting']).toContain(ably.connection.state); // subscribe below happens before connected
        const privateChannel: any = echo.private('startup');
        const presenceChannel: any = echo.join('startup');
        const errors: any[] = [];
        privateChannel.error((e) => errors.push(e));
        presenceChannel.error((e) => errors.push(e));
        await Promise.all([privateChannel, presenceChannel].map((c) => new Promise((resolve) => c.subscribed(resolve))));
        expect(privateChannel.channel.state).toBe('attached');
        expect(presenceChannel.channel.state).toBe('attached');

        // outlast ably-js's slow-connection timer, which opened the ws-up probe
        await new Promise((resolve) => setTimeout(resolve, 8000));

        const hosts = recordedSockets().map((s) => s.url);
        expect(hosts.filter((h) => h.includes('ws-up'))).toEqual([]);
        expect(recordedSockets()).toHaveLength(1);
        expect(socketsWithConnected()).toBe(1); // no second socket CONNECTED (in-band AUTH repeats CONNECTED on the same socket)
        expect(connectionIds()).toHaveLength(1);
        expect(ably.connection.state).toBe('connected');
        expect(privateChannel.channel.state).toBe('attached');
        expect(presenceChannel.channel.state).toBe('attached');
        expect(errors).toEqual([]);
        await waitForExpect(() => expect(ably.connection.state).toBe('connected'));
    });
});
