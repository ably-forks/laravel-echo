/**
 * R7: the default Laravel setup (authEndpoint -> fetch) end to end against the Ably sandbox, with a local
 * /broadcasting/auth server backed by MockAuthServer. Every other integration test uses requestTokenFn.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import * as Ably from '@ably/pubsub-device';
import Echo from '../../src/echo';
import { AblyChannel, AblyPrivateChannel } from '../../src/channel';
import waitForExpect from 'wait-for-expect';
import { setup, tearDown } from './setup/sandbox';
import { MockAuthServer } from './setup/mock-auth-server';

jest.setTimeout(30000);

describe('authEndpoint end to end', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let server: http.Server;
    let authEndpoint: string;
    let mode: 'ok' | 'empty-channel-token' | 'channel-403' | 'connection-403' | 'connection-401' = 'ok';
    const requests: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];

    beforeAll(async () => {
        global.Ably = Ably;
        testApp = await setup();
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
        server = http.createServer(async (req, res) => {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw || '{}');
            requests.push({ headers: req.headers, body });
            res.setHeader('content-type', 'application/json');
            const isChannelRequest = !!body.channel_name;
            if ((mode === 'connection-403' || mode === 'connection-401') && !isChannelRequest) {
                res.statusCode = mode === 'connection-403' ? 403 : 401;
                return res.end(JSON.stringify({ message: 'no' }));
            }
            if (mode === 'channel-403' && isChannelRequest) {
                res.statusCode = 403;
                return res.end(JSON.stringify({ message: 'This action is unauthorized.' }));
            }
            if (mode === 'empty-channel-token' && isChannelRequest) {
                return res.end('{}');
            }
            res.end(JSON.stringify(await mockAuthServer.getSignedToken(body.channel_name, body.token)));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        authEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/broadcasting/auth`;
    });

    afterAll(async () => {
        server.close();
        await tearDown(testApp);
    });

    const makeEcho = () =>
        new Echo({
            broadcaster: 'ably',
            endpoint: 'nonprod:sandbox',
            authEndpoint,
            csrfToken: 'csrf-1',
            bearerToken: 'bt-1',
        });

    test('private channel attaches through authEndpoint; CSRF and Authorization headers are sent', async () => {
        mode = 'ok';
        const echo = makeEcho();
        await new Promise<void>((resolve, reject) => echo.private('r7').subscribed(() => resolve()).error(reject));
        const channelRequest = requests.find((r) => r.body.channel_name === 'private:r7');
        expect(channelRequest.headers['x-csrf-token']).toBe('csrf-1');
        expect(channelRequest.headers['authorization']).toBe('Bearer bt-1');
        echo.disconnect();
    });

    test('public channel receives a message with the connection token obtained through authEndpoint', async () => {
        mode = 'ok';
        const before = requests.length;
        const echo = makeEcho();
        const data = await new Promise((resolve) => {
            const channel = echo.channel('r7pub') as AblyChannel;
            channel
                .subscribed(() => mockAuthServer.broadcast('public:r7pub', 'App\\Events\\testEvent', 'via authEndpoint'))
                .listen('testEvent', resolve);
        });
        expect(data).toBe('via authEndpoint');
        // the connection token itself came from authEndpoint (channel_name null)
        expect(requests.slice(before).some((r) => r.body.channel_name == null)).toBe(true);
        echo.disconnect();
    });

    test('user login through authEndpoint: guest -> user (40102) reconnects and re-attaches public and private channels', async () => {
        mode = 'ok';
        mockAuthServer.clientId = null; // guest
        const echo = makeEcho();
        try {
            await waitForExpect(() => expect(echo.connector.ably.connection.state).toBe('connected'));
            const publicChannel = echo.channel('r7login') as AblyChannel;
            await new Promise((resolve) => publicChannel.subscribed(resolve));
            expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull();

            mockAuthServer.clientId = 'sacOO7@github.com'; // user logs in for the next auth request
            const privateChannel = echo.private('r7login') as AblyPrivateChannel;
            const privateChannelErr: Promise<any> = new Promise((resolve) => privateChannel.error(resolve));
            const channelsReattached = Promise.all([
                new Promise((resolve) => publicChannel.subscribed(resolve)),
                new Promise((resolve) => privateChannel.subscribed(resolve)),
            ]);
            expect(String((await privateChannelErr).message).toLowerCase()).toContain('mismatched clientid');
            await channelsReattached;
            expect(privateChannel.channel.state).toBe('attached');
            expect(echo.connector.ablyAuth.existingToken().clientId).toBe('sacOO7@github.com');
        } finally {
            echo.disconnect();
            mockAuthServer.clientId = 'sacOO7@github.com';
        }
    });

    test('presence channel: here() receives the member list through authEndpoint', async () => {
        mode = 'ok';
        const echo = makeEcho();
        const members = await new Promise<any[]>((resolve, reject) => echo.join('r7p').here(resolve).error(reject));
        expect(Array.isArray(members)).toBe(true);
        echo.disconnect();
    });

    test('channel request returning {} -> error() gets code 50000 and the connection stays connected', async () => {
        mode = 'empty-channel-token';
        const echo = makeEcho();
        const err: any = await new Promise((resolve) => echo.private('r7b').error(resolve));
        expect(err).toMatchObject({ code: 50000, statusCode: 500 });
        expect(echo.connector.ably.connection.state).not.toBe('failed');
        echo.disconnect();
    });

    test('channel request 403 -> error() gets {code: 40300, statusCode: 403}; connection unaffected', async () => {
        mode = 'channel-403';
        const echo = makeEcho();
        const err: any = await new Promise((resolve) => echo.private('r7c').error(resolve));
        expect(err).toMatchObject({ code: 40300, statusCode: 403 });
        expect(echo.connector.ably.connection.state).not.toBe('failed');
        echo.disconnect();
    });

    test.each([
        ['connection-403', 'failed', 40300],
        ['connection-401', 'disconnected', 40100],
    ] as const)('connection-token request %s -> connection %s (cause %s)', async (m, expectedState, causeCode) => {
        mode = m;
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const echo = makeEcho();
        const stateChange: any = await new Promise((resolve) =>
            echo.connector.ably.connection.on((c: any) => {
                if (c.current === 'failed' || c.current === 'disconnected') resolve(c);
            })
        );
        expect(stateChange.current).toBe(expectedState);
        expect(stateChange.reason?.cause?.code).toBe(causeCode);
        echo.disconnect();
        (console.error as jest.Mock).mockRestore();
    });
});
