import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyChannel, AblyPrivateChannel } from '../../src/channel';
import * as Ably from 'ably';
import waitForExpect from 'wait-for-expect';

jest.setTimeout(30000);
describe('AblyUserLogin', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echo: Echo;

    beforeAll(async () => {
        global.Ably = Ably;
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

        // Since new clientId is returned in the new token, ably returns mismatched error for given auth request
        const privateChannelErr : Error = await new Promise(resolve => privateChannel.error(resolve));
        expect(privateChannelErr.message.toLowerCase()).toContain('mismatched clientid for existing connection');

        // Reconnects again and starts explicit attach for all channels
        await waitForExpect(() => {
            expect(echo.connector.ably.connection.state).toBe('connected')
        });

        // Attaches both public and private channel
        await Promise.all([ 
            new Promise(resolve => publicChannel.subscribed(resolve)),
            new Promise(resolve => privateChannel.subscribed(resolve))
        ]);

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
        let connectionStates : Array<any>= []
        let privateChannelStates : Array<any>= []

        // Initial clientId is null
        expect(mockAuthServer.clientId).toBeNull();
        await waitForExpect(() => {
            expect(echo.connector.ably.connection.state).toBe('connected');
        });

        // Track all connection state changes
        echo.connector.ably.connection.on(stateChange => {
            connectionStates.push(stateChange.current)
        });

        // Making sure client is still anonymous
        expect(mockAuthServer.clientId).toBeNull();
        expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull()

        // Set server clientId to sacOO7@github.com, so user logs in for next request
        mockAuthServer.clientId = 'sacOO7@github.com'
        const privateChannel = echo.private('test') as AblyPrivateChannel; // Requests new token     
        privateChannel.channel.on(statechange => {
            privateChannelStates.push(statechange.current)
        })
        const privateChannel1ErrPromise = new Promise((resolve) => privateChannel.error(resolve))
       
        await new Promise((resolve) => privateChannel.subscribed(resolve)); // successful attach 
        await waitForExpect(() => {
            expect(connectionStates).toStrictEqual(['failed', 'connecting', 'connected'])
        });

        // Logout user by setting clientId to null
        mockAuthServer.clientId = null
        const privateChannel2 = echo.private('test1') as AblyPrivateChannel; // Requests new token with null clientId

        // Receives error on both channels
        const privateChannel1Err = await privateChannel1ErrPromise as any;
        const privateChannel2Err = await new Promise((resolve) => privateChannel2.error(resolve)) as any;

        const errMsg = 'mismatched clientid for existing connection'
        expect(privateChannel1Err.message.toLowerCase()).toContain(errMsg);
        expect(privateChannel2Err.message.toLowerCase()).toContain(errMsg);

        await waitForExpect(() => {
            expect(privateChannelStates).toStrictEqual(['attaching', 'attached', 'failed']);
        });

        // Connection transitions to failed state
        await waitForExpect(() => {
            expect(connectionStates).toStrictEqual(['failed', 'connecting', 'connected', 'failed'])
        });

        expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull();
    });
});
