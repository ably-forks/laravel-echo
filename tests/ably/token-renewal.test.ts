import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyChannel } from '../../src/channel';
import { parseJwt } from '../../src/channel/ably/utils';
import waitForExpect from 'wait-for-expect';

const TOKEN_EXPIRY_S = 6;

jest.setTimeout(TOKEN_EXPIRY_S * 1000 + 30000);
describe('Token renewal', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echo: Echo;
    let tokenRequests: Array<{ channelName: string | null; existingToken: string | null; token: string }>;

    beforeAll(async () => {
        testApp = await setup();
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
        mockAuthServer.tokenExpiry = TOKEN_EXPIRY_S;
    });

    afterAll(async () => {
        return await tearDown(testApp);
    });

    beforeEach(() => {
        tokenRequests = [];
        echo = new Echo({
            broadcaster: 'ably',
            useTls: true,
            endpoint: 'nonprod:sandbox',
            requestTokenFn: async (channelName, existingToken) => {
                const response = await mockAuthServer.getSignedToken(channelName, existingToken);
                tokenRequests.push({ channelName, existingToken, token: response.token });
                return response;
            },
        });
    });

    afterEach((done) => {
        echo.disconnect();
        echo.connector.ably.connection.once('closed', () => {
            done();
        });
    });

    // Skipped: laravel-broadcaster's getSignedToken (AblyBroadcaster.php) keeps the claims of the existing token only
    // while it is still valid (Utils::isJwtValid). Once it has expired, the renewal request ({channel_name: null,
    // token: <expired token>}) gets a token with the public claims only. Reproduced on the live sandbox: after every
    // expiry the private channel fails with 40160 and Echo re-authorizes it through handleChannelAuthError, and
    // broadcasts sent in that window are lost. Un-skip once the broadcaster keeps private claims on renewal.
    test.skip('private access survives a token renewal (skipped: laravel-broadcaster drops private claims on renewal: the renewed token has only public:* capability, the channel fails with 40160)', async () => {
        const ablyClient = echo.connector.ably;
        const privateChannel = echo.private('renewal') as AblyChannel;
        const received: Array<string> = [];
        let onReceived: () => void;
        privateChannel.listen('.renewalEvent', (data) => {
            received.push(data);
            onReceived?.();
        });
        await new Promise((resolve) => privateChannel.subscribed(resolve));

        const channelStateChanges: Array<any> = [];
        privateChannel.channel.on((stateChange) => channelStateChanges.push(stateChange));
        // ably-js clears auth.tokenDetails while it re-authorizes, so take the expiry from the issued tokens
        const initialExpires = Math.max(...tokenRequests.map(({ token }) => parseJwt(token).payload.exp)) * 1000;

        // A renewal has happened once the client holds a token with a later expiry
        await waitForExpect(
            () => expect(ablyClient.auth.tokenDetails?.expires).toBeGreaterThan(initialExpires),
            TOKEN_EXPIRY_S * 1000 + 15000,
            100
        );
        const renewal = tokenRequests.find(
            ({ channelName, existingToken, token }) =>
                channelName === null && existingToken && parseJwt(token).payload.exp * 1000 > initialExpires
        );
        expect(renewal).toBeDefined(); // renewed through the auth endpoint, sending the existing token
        expect(parseJwt(renewal.token).payload['x-ably-capability']).toContain('"private:renewal"');

        await waitForExpect(() => expect(ablyClient.connection.state).toBe('connected'), 10000, 100);

        // Broadcast after the renewal and wait for it; fail fast if the channel loses access instead
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('broadcast after renewal not received')), 10000);
            const done = (err?: Error) => {
                clearTimeout(timer);
                privateChannel.channel.off('failed', onFailed);
                err ? reject(err) : resolve();
            };
            const onFailed = (stateChange) => done(new Error(`channel failed: ${stateChange.reason?.code}`));
            onReceived = () => done();
            privateChannel.channel.on('failed', onFailed);
            mockAuthServer.broadcast('private:renewal', 'renewalEvent', 'after renewal').catch(done);
        });

        expect(received).toStrictEqual(['after renewal']);
        expect(privateChannel.channel.state).toBe('attached');
        expect(channelStateChanges.filter((stateChange) => stateChange.reason?.code === 40160)).toStrictEqual([]);
        expect(channelStateChanges.map((stateChange) => stateChange.current)).not.toContain('failed');
    });
});
