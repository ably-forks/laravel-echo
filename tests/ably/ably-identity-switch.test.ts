import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyChannel, AblyPrivateChannel } from '../../src/channel';
import { createClient } from '@ably/pubsub-device';
import waitForExpect from 'wait-for-expect';
import { trackUnhandledRejections } from '../parity/fake-ably';

jest.setTimeout(45000);

/**
 * Identity switches inside one page (guest -> user, user -> user, user -> guest, null -> user -> null) against the
 * sandbox. A switch is triggered by changing mockAuthServer.clientId and requesting a new private channel; a logout
 * is the documented in-page path: the app calls echo.connect() and re-subscribes its channels.
 */
describe('AblyIdentitySwitch', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echo: Echo;
    let observer: any;
    let rejections: ReturnType<typeof trackUnhandledRejections>;

    beforeAll(async () => {
        testApp = await setup();
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
    });

    afterAll(async () => {
        return await tearDown(testApp);
    });

    const makeEcho = () =>
        new Echo({
            broadcaster: 'ably',
            useTls: true,
            endpoint: 'nonprod:sandbox',
            requestTokenFn: mockAuthServer.getSignedToken,
            echoMessages: true,
        });

    const connected = (e: Echo = echo) =>
        waitForExpect(() => expect(e.connector.ably.connection.state).toBe('connected'));

    const attached = (ch: AblyChannel | AblyPrivateChannel) =>
        waitForExpect(() => expect(ch.channel.state).toBe('attached'));

    const trackStates = (emitter: any) => {
        const states: string[] = [];
        emitter.on((stateChange: any) => states.push(stateChange.current));
        return states;
    };

    const count = (states: string[], state: string) => states.filter((s) => s === state).length;

    /** Subscribe a public channel and assert a broadcast published after (re-)attach is received. */
    const expectReceives = async (channel: AblyChannel, shortName: string) => {
        await attached(channel);
        const event = `evt-${Math.random().toString(36).slice(2)}`;
        const received = new Promise((resolve) => channel.listen(`.${event}`, resolve));
        // subscribe() resolves on attach; publish once the listener is registered
        await new Promise((resolve) => setTimeout(resolve, 200));
        await mockAuthServer.broadcast(`public:${shortName}`, event, 'hello');
        expect(await received).toBe('hello');
    };

    const expectNoUnhandledRejections = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50)); // let Node emit pending unhandledRejection events
        expect(rejections.rejections).toStrictEqual([]);
    };

    beforeEach(() => {
        mockAuthServer.clientId = null;
        mockAuthServer.guestClientId = false;
        mockAuthServer.rotateGuestId();
        rejections = trackUnhandledRejections();
    });

    afterEach(async () => {
        rejections.stop();
        mockAuthServer.guestClientId = false;
        mockAuthServer.clientId = null;
        mockAuthServer.publicCapability = ['subscribe', 'history', 'channel-metadata'];
        observer?.close();
        observer = undefined;
        const client = echo.connector.ably;
        echo.disconnect();
        await waitForExpect(() => expect(['closed', 'failed']).toContain(client.connection.state));
    });

    test('guest id -> user1: no error() call, recovers as user1, channels attached, public message received', async () => {
        mockAuthServer.guestClientId = true;
        mockAuthServer.publicCapability = ['subscribe', 'history', 'channel-metadata', 'publish', 'presence'];
        echo = makeEcho();
        await connected();
        expect(echo.connector.ably.auth.clientId).toBe(mockAuthServer.guestId);
        // second client with the API key: reads the server-stamped clientId of what the page publishes
        observer = createClient({ key: testApp.keys[0].keyStr, endpoint: 'nonprod:sandbox' } as any);
        const seen: Array<{ name: string; clientId: any }> = [];
        await observer.channels.get('public:x').subscribe((m: any) => seen.push({ name: m.name, clientId: m.clientId }));

        const publicChannel = echo.channel('t2') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const connectionStates = trackStates(echo.connector.ably.connection);

        mockAuthServer.clientId = 'user1';
        const privateChannel = echo.private('t2') as AblyPrivateChannel;
        const errorSpy = jest.fn(); // E3: the transient 40102 of the switch is suppressed on both channels
        publicChannel.error(errorSpy);
        privateChannel.error(errorSpy);
        await new Promise((resolve) => privateChannel.subscribed(resolve));

        await connected();
        await attached(publicChannel);
        await attached(privateChannel);
        expect(echo.connector.ably.auth.clientId).toBe('user1');
        expect(echo.connector.ablyAuth.existingToken().clientId).toBe('user1');
        expect(connectionStates).toStrictEqual(['failed', 'connecting', 'connected']);

        const event = `probe-${Math.random().toString(36).slice(2)}`;
        await echo.connector.ably.channels.get('public:x').publish(event, 'x');
        await waitForExpect(() => expect(seen.some((m) => m.name === event)).toBe(true));
        expect(seen.find((m) => m.name === event)?.clientId).toBe('user1');

        await expectReceives(publicChannel, 't2');
        expect(errorSpy).toHaveBeenCalledTimes(0); // E3
        await expectNoUnhandledRejections();
    });

    test('user1 -> user2 -> user3 in one page: both recover, one failed per switch, one ATTACH per channel per connection', async () => {
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const publicChannel = echo.channel('t3') as AblyChannel;
        const privateChannel = echo.private('t3') as AblyPrivateChannel;
        // register both listeners before awaiting: either channel may attach first
        await Promise.all([
            new Promise((resolve) => publicChannel.subscribed(resolve)),
            new Promise((resolve) => privateChannel.subscribed(resolve)),
        ]);
        await connected();
        await attached(privateChannel);
        // the first private request moves the connection from the null connection token to user1
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));

        const connectionStates = trackStates(echo.connector.ably.connection);
        // Per channel: the number of 'attaching' state changes, observable as one ATTACH per channel per connection
        const publicStates = trackStates(publicChannel.channel);
        const privateStates = trackStates(privateChannel.channel);
        const errorSpy = jest.fn();
        publicChannel.error(errorSpy);
        privateChannel.error(errorSpy);

        for (const [i, user] of ['user2', 'user3'].entries()) {
            mockAuthServer.clientId = user;
            const trigger = echo.private(`t3-switch${i}`) as AblyPrivateChannel;
            trigger.error(errorSpy);
            await new Promise((resolve) => trigger.subscribed(resolve));
            await connected();
            await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe(user));
            await attached(publicChannel);
            await attached(privateChannel);
            await attached(trigger);
            // exactly one failed per switch (no loop), and one ATTACH (attaching) per channel per new connection
            await waitForExpect(() => expect(count(connectionStates, 'failed')).toBe(i + 1));
            await waitForExpect(() => expect(count(publicStates, 'attaching')).toBe(i + 1));
            await waitForExpect(() => expect(count(privateStates, 'attaching')).toBe(i + 1));
        }

        expect(count(connectionStates, 'failed')).toBeLessThanOrEqual(2);
        expect(count(connectionStates, 'connected')).toBe(2);
        expect(errorSpy).toHaveBeenCalledTimes(0); // E3
        await expectNoUnhandledRejections();
    });

    test('user1 -> guest id logout via echo.connect(): new guest id, public receives, private re-auth gives 403', async () => {
        mockAuthServer.guestClientId = true;
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const publicChannel = echo.channel('t4') as AblyChannel;
        const privateChannel = echo.private('t4') as AblyPrivateChannel;
        // register both listeners before awaiting: either channel may attach first
        await Promise.all([
            new Promise((resolve) => publicChannel.subscribed(resolve)),
            new Promise((resolve) => privateChannel.subscribed(resolve)),
        ]);
        await connected();
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const previousGuestId = mockAuthServer.guestId;

        // logout
        const oldClient = echo.connector.ably;
        mockAuthServer.clientId = null;
        mockAuthServer.rotateGuestId();
        echo.connect();
        const newClient = echo.connector.ably;
        expect(newClient).not.toBe(oldClient);
        await connected();
        expect(mockAuthServer.guestId).not.toBe(previousGuestId);
        expect(newClient.auth.clientId).toBe(mockAuthServer.guestId);
        await waitForExpect(() => expect(['closing', 'closed']).toContain(oldClient.connection.state));

        const publicAgain = echo.channel('t4') as AblyChannel;
        await new Promise((resolve) => publicAgain.subscribed(resolve));
        await expectReceives(publicAgain, 't4');

        const privateAgain = echo.private('t4') as AblyPrivateChannel;
        const err: any = await new Promise((resolve) => privateAgain.error(resolve));
        expect(err.statusCode === 403 || err.code === 40300).toBe(true);
        expect(echo.connector.ably.connection.state).toBe('connected');
        await expectNoUnhandledRejections();
    });

    test('non-MAU: null -> user1 recovers, then user1 -> null via echo.connect() recovers with a null clientId', async () => {
        echo = makeEcho();
        await connected();
        expect(echo.connector.ably.auth.clientId).toBeFalsy();
        const publicChannel = echo.channel('t5') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));

        mockAuthServer.clientId = 'user1';
        const privateChannel = echo.private('t5') as AblyPrivateChannel;
        const errorSpy = jest.fn();
        privateChannel.error(errorSpy);
        publicChannel.error(errorSpy);
        await new Promise((resolve) => privateChannel.subscribed(resolve));
        await connected();
        await attached(publicChannel);
        expect(echo.connector.ably.auth.clientId).toBe('user1');
        expect(errorSpy).toHaveBeenCalledTimes(0); // E3

        // logout
        const oldClient = echo.connector.ably;
        mockAuthServer.clientId = null;
        echo.connect();
        await connected();
        expect(echo.connector.ably).not.toBe(oldClient);
        expect(echo.connector.ably.auth.clientId).toBeFalsy();
        expect(echo.connector.ablyAuth.existingToken().clientId).toBeNull();
        await waitForExpect(() => expect(['closing', 'closed']).toContain(oldClient.connection.state));

        const publicAgain = echo.channel('t5') as AblyChannel;
        await new Promise((resolve) => publicAgain.subscribed(resolve));
        await expectReceives(publicAgain, 't5');
        await expectNoUnhandledRejections();
    });
});
