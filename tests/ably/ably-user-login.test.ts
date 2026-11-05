import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyChannel, AblyPrivateChannel } from '../../src/channel';
import waitForExpect from 'wait-for-expect';
import { trackUnhandledRejections } from '../parity/fake-ably';

jest.setTimeout(30000);
describe('AblyUserLogin', () => {
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
        mockAuthServer.clientId = null;
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

    test('user logs in without previous (public) channels', async () => {
        let connectionStates : Array<any>= []
        // Initial clientId is null
        expect(mockAuthServer.clientId).toBeNull();
        await waitForExpect(() => {
            expect(echo.connector.ably.connection.state).toBe('connected')
        });

        // Track all connection state changes
        echo.connector.ably.connection.on(stateChange => {
            connectionStates.push(stateChange.current)
        });

        // Making sure client is still anonymous
        expect(mockAuthServer.clientId).toBeNull();
        expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull()

        // Set server clientId to sacOO7@github.com, user logs in for next request
        mockAuthServer.clientId = 'sacOO7@github.com'
        const privateChannel = echo.private('test') as AblyPrivateChannel; // Requests new token        
        await new Promise((resolve) => privateChannel.subscribed(resolve));

        // Connection goes into failed state and then reconnects again
        await waitForExpect(() => {
            expect(connectionStates).toStrictEqual(['failed', 'connecting', 'connected'])
        });
        expect(privateChannel.channel.state).toBe('attached');

        expect(echo.connector.ablyAuth.existingToken().clientId).toBe('sacOO7@github.com');
    });

    test('user logs in with previous (public) channels', async () => {
        let connectionStates : Array<any>= []
        let publicChannelStates : Array<any>= []

        // Initial clientId is null
        expect(mockAuthServer.clientId).toBeNull();
        await waitForExpect(() => {
            expect(echo.connector.ably.connection.state).toBe('connected')
        });

        // Track all connection state changes
        echo.connector.ably.connection.on(stateChange => {
            connectionStates.push(stateChange.current)
        })

        // Subscribe to a public channel as a guest user
        const publicChannel = echo.channel('test1') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        publicChannel.channel.on(stateChange => {
            publicChannelStates.push(stateChange.current)
        })

        // Making sure client is still anonymous
        expect(mockAuthServer.clientId).toBeNull();
        expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull();

        // Set server clientId to sacOO7@github.com, user logs in for next request
        mockAuthServer.clientId = 'sacOO7@github.com';
        const privateChannel = echo.private('test') as AblyPrivateChannel; // requests new token for channel `test`

        // Register listeners up front, since reconnect and re-attach can complete before an error would be observed
        // E3: the transient 40102 ("mismatched clientid") of the Echo-initiated switch is suppressed, so error() is not called
        const errorSpy = jest.fn();
        privateChannel.error(errorSpy);
        publicChannel.error(errorSpy);
        const channelsReattached = Promise.all([
            new Promise(resolve => publicChannel.subscribed(resolve)),
            new Promise(resolve => privateChannel.subscribed(resolve))
        ]);

        // Reconnects again and starts explicit attach for all channels
        await waitForExpect(() => {
            expect(echo.connector.ably.connection.state).toBe('connected')
        });

        // Attaches both public and private channel
        await channelsReattached;
        expect(errorSpy).toHaveBeenCalledTimes(0); // E3

        await waitForExpect(() => {
            expect(connectionStates).toStrictEqual(['failed', 'connecting', 'connected']);
        });
        await waitForExpect(() => {
            expect(publicChannelStates).toStrictEqual(['failed', 'attaching', 'attached']);
        });
        expect(privateChannel.channel.state).toBe('attached');

        expect(echo.connector.ablyAuth.existingToken().clientId).toBe('sacOO7@github.com');
    });

    test('user logs in and then logs out', async() => {
        const rejections = trackUnhandledRejections();
        let connectionStates : Array<any>= []

        expect(mockAuthServer.clientId).toBeNull();
        await waitForExpect(() => {
            expect(echo.connector.ably.connection.state).toBe('connected');
        });
        echo.connector.ably.connection.on(stateChange => {
            connectionStates.push(stateChange.current)
        });
        expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull()

        // login: null -> user
        mockAuthServer.clientId = 'sacOO7@github.com'
        const privateChannel = echo.private('test') as AblyPrivateChannel; // Requests new token
        const loginErrorSpy = jest.fn();
        privateChannel.error(loginErrorSpy);
        await new Promise((resolve) => privateChannel.subscribed(resolve)); // successful attach
        await waitForExpect(() => {
            expect(connectionStates).toStrictEqual(['failed', 'connecting', 'connected'])
        });
        expect(loginErrorSpy).toHaveBeenCalledTimes(0); // E3
        expect(echo.connector.ablyAuth.existingToken().clientId).toBe('sacOO7@github.com');

        // logout: the documented in-page path is echo.connect() (replaces the connector, closes the old client)
        const oldClient = echo.connector.ably;
        mockAuthServer.clientId = null
        echo.connect();
        const newClient = echo.connector.ably;
        expect(newClient).not.toBe(oldClient);
        await waitForExpect(() => {
            expect(newClient.connection.state).toBe('connected');
            expect(['closing', 'closed']).toContain(oldClient.connection.state);
        });
        expect(newClient.auth.clientId).toBeFalsy();
        expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull();

        // public channel re-subscribed by the caller receives again
        const publicChannel = echo.channel('test-logout') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const received = new Promise((resolve) => publicChannel.listen('.logout-event', resolve));
        await mockAuthServer.broadcast('public:test-logout', 'logout-event', JSON.stringify({ ok: true }));
        await received;

        // private channel re-requested as a guest: the auth endpoint answers 403
        const guestPrivate = echo.private('test') as AblyPrivateChannel;
        const guestErr: any = await new Promise((resolve) => guestPrivate.error(resolve));
        expect(guestErr.statusCode === 403 || guestErr.code === 40300).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 50)); // let Node emit pending unhandledRejection events
        rejections.stop();
        expect(rejections.rejections).toStrictEqual([]);
    });
});
