import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyChannel, AblyPrivateChannel } from '../../src/channel';
import { createClient } from '@ably/pubsub-device';
import waitForExpect from 'wait-for-expect';
import { trackUnhandledRejections } from '../parity/fake-ably';

jest.setTimeout(60000);

/**
 * Identity switch on a RENEWED connection token: another tab logged in or out, so the next token the page is handed
 * carries another clientId (the mock's clientId / guestClientId change, and the test waits for the renewal; Echo
 * never calls echo.connect()). Echo's authCallback then switches identity itself (switchIdentityOnRenewal): one
 * reconnect as the new identity, channels re-attach, private ones re-authorize. Outcomes match the in-page
 * equivalents in ably-identity-switch.test.ts.
 */
describe('AblyRenewalSwitch', () => {
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

    beforeEach(() => {
        mockAuthServer.clientId = null;
        mockAuthServer.guestClientId = false;
        mockAuthServer.rotateGuestId();
        mockAuthServer.tokenExpiry = 6;
        mockAuthServer.publicCapability = ['subscribe', 'history', 'channel-metadata', 'publish', 'presence'];
        rejections = trackUnhandledRejections();
    });

    afterEach(async () => {
        rejections.stop();
        mockAuthServer.clientId = null;
        mockAuthServer.guestClientId = false;
        mockAuthServer.tokenExpiry = 60;
        mockAuthServer.publicCapability = ['subscribe', 'history', 'channel-metadata'];
        observer?.close();
        observer = undefined;
        const client = echo?.connector?.ably;
        if (client) {
            echo.disconnect();
            await waitForExpect(() => expect(['closed', 'failed']).toContain(client.connection.state));
        }
    });

    const makeEcho = () =>
        new Echo({
            broadcaster: 'ably',
            useTls: true,
            endpoint: 'nonprod:sandbox',
            requestTokenFn: mockAuthServer.getSignedToken,
            echoMessages: true,
        });

    const connected = () => waitForExpect(() => expect(echo.connector.ably.connection.state).toBe('connected'));
    const attached = (ch: AblyChannel | AblyPrivateChannel) =>
        waitForExpect(() => expect(ch.channel.state).toBe('attached'));
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** Records connection states and the recovery time from the first non-connected state after the switch starts. */
    const watchConnection = () => {
        const states: string[] = [];
        let armed = false;
        let firstDown: number | null = null;
        let recoveredAt: number | null = null;
        echo.connector.ably.connection.on((change: any) => {
            states.push(change.current);
            if (!armed) return;
            if (change.current !== 'connected' && firstDown === null) firstDown = Date.now();
            if (change.current === 'connected' && firstDown !== null) recoveredAt = Date.now();
        });
        return {
            states,
            arm: () => (armed = true),
            count: (s: string) => states.filter((x) => x === s).length,
            recoveryMs: () => (firstDown !== null && recoveredAt !== null ? recoveredAt - firstDown : null),
        };
    };

    /** Second client with the API key: reads the server-stamped clientId of what the page publishes. */
    const observe = async (name: string) => {
        observer = createClient({ key: testApp.keys[0].keyStr, endpoint: 'nonprod:sandbox' } as any);
        const seen: Array<{ name: string; clientId: any }> = [];
        const channel = observer.channels.get(name);
        await channel.subscribe((m: any) => seen.push({ name: m.name, clientId: m.clientId }));
        return seen;
    };

    const pagePublishSeenAs = async (seen: Array<{ name: string; clientId: any }>, channel: string) => {
        const event = `probe-${Math.random().toString(36).slice(2)}`;
        await echo.connector.ably.channels.get(channel).publish(event, 'x');
        await waitForExpect(() => expect(seen.some((m) => m.name === event)).toBe(true));
        return seen.find((m) => m.name === event)?.clientId;
    };

    const expectReceives = async (channel: AblyChannel, shortName: string) => {
        await attached(channel);
        const event = `evt-${Math.random().toString(36).slice(2)}`;
        const received = new Promise((resolve) => channel.listen(`.${event}`, resolve));
        await sleep(200);
        await mockAuthServer.broadcast(`public:${shortName}`, event, 'hello');
        expect(await received).toBe('hello');
    };

    const expectNoUnhandledRejections = async () => {
        await sleep(50);
        expect(rejections.rejections).toStrictEqual([]);
    };

    const is403 = (e: any) => e?.statusCode === 403 || e?.code === 40300;

    /**
     * After a logout, the private channel's error() gets exactly one error: the broadcaster's 403 from the
     * re-authorization, as with the in-page logout. The transient 40160 of ably-js's own re-attach is not reported.
     */
    const expectOne403 = (errors: any[]) => {
        console.log(`private error() sequence: ${errors.map((e) => e?.reason?.code ?? e?.code).join(',')}`);
        expect(errors).toHaveLength(1);
        expect(is403(errors[0])).toBe(true);
    };

    /** Wait for the renewal switch: the connection recovered as the expected identity. */
    const recovered = (conn: ReturnType<typeof watchConnection>, expectedId: () => string | null) =>
        waitForExpect(() => {
            expect(conn.recoveryMs()).not.toBeNull();
            expect(echo.connector.ably.connection.state).toBe('connected');
            expect(echo.connector.ably.auth.clientId ?? null).toBe(expectedId());
        }, 40000, 250);

    test('user1 -> guest id: reconnects once as the guest in under 5 s, public re-attached, private gets one 403', async () => {
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const publicChannel = echo.channel('r1') as AblyChannel;
        const privateChannel = echo.private('r1') as AblyPrivateChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        await new Promise((resolve) => privateChannel.subscribed(resolve));
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const seen = await observe('public:x');
        const publicErrors = jest.fn();
        const privateErrors: any[] = [];
        publicChannel.error(publicErrors);
        privateChannel.error((e: any) => privateErrors.push(e));
        const conn = watchConnection();

        mockAuthServer.guestClientId = true;
        mockAuthServer.clientId = null;
        conn.arm();
        await recovered(conn, () => mockAuthServer.guestId);

        const ms = conn.recoveryMs() ?? Infinity;
        console.log(`user1 -> guest recovery: ${ms} ms, states: ${conn.states.join(',')}`);
        expect(ms).toBeLessThan(5000);
        expect(conn.count('failed')).toBe(0);
        expect(await pagePublishSeenAs(seen, 'public:x')).toBe(mockAuthServer.guestId);
        await expectReceives(publicChannel, 'r1');
        await waitForExpect(() => expect(privateErrors.length).toBeGreaterThanOrEqual(1));
        await sleep(1000);
        expectOne403(privateErrors);
        expect(publicErrors).not.toHaveBeenCalled();
        expect(conn.count('failed')).toBe(0);
        await expectNoUnhandledRejections();
    });

    test('user1 -> null: reconnects as an anonymous client, server no longer attributes it to user1, private gets one 403', async () => {
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const publicChannel = echo.channel('r2') as AblyChannel;
        const privateChannel = echo.private('r2') as AblyPrivateChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        await new Promise((resolve) => privateChannel.subscribed(resolve));
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const seen = await observe('public:x');
        const publicErrors = jest.fn();
        const privateErrors: any[] = [];
        publicChannel.error(publicErrors);
        privateChannel.error((e: any) => privateErrors.push(e));
        const conn = watchConnection();

        mockAuthServer.clientId = null; // guestClientId stays false
        conn.arm();
        await recovered(conn, () => null);

        console.log(`user1 -> null recovery: ${conn.recoveryMs()} ms, states: ${conn.states.join(',')}`);
        expect(conn.recoveryMs() ?? Infinity).toBeLessThan(5000);
        expect(echo.connector.ably.auth.clientId).toBeFalsy();
        expect(conn.count('failed')).toBe(0);
        const stamped = await pagePublishSeenAs(seen, 'public:x');
        expect(stamped ?? null).toBeNull();
        expect(stamped).not.toBe('user1');
        // the page can no longer act as user1: presence.enter() needs a clientId
        const members: any[] = [];
        await observer.channels.get('public:x').presence.subscribe((m: any) => members.push(m));
        let enterCode: any = 'resolved';
        try {
            await Promise.race([
                echo.connector.ably.channels.get('public:x').presence.enter('x'),
                sleep(8000).then(() => Promise.reject(new Error('timeout'))),
            ]);
        } catch (e: any) {
            enterCode = e?.code ?? e?.message;
        }
        console.log(`user1 -> null presence.enter() result: ${enterCode}`);
        expect(enterCode).not.toBe('resolved');
        expect(enterCode).not.toBe('timeout');
        await sleep(500);
        expect(members.filter((m) => m.clientId === 'user1')).toStrictEqual([]);
        await expectReceives(publicChannel, 'r2');
        await waitForExpect(() => expect(privateErrors.length).toBeGreaterThanOrEqual(1));
        await sleep(1000);
        expectOne403(privateErrors);
        expect(publicErrors).not.toHaveBeenCalled();
        await expectNoUnhandledRejections();
    });

    test.each([false, true])('user1 -> user2 (with a private channel: %s): reconnects as user2 in under 5 s instead of staying failed', async (withPrivate) => {
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const publicChannel = echo.channel('r3') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const privateChannel = withPrivate ? (echo.private('r3') as AblyPrivateChannel) : undefined;
        const privateErrors: any[] = [];
        if (privateChannel) {
            await new Promise((resolve) => privateChannel.subscribed(resolve));
            privateChannel.error((e: any) => privateErrors.push(e));
        }
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const seen = await observe('public:x');
        const errorSpy = jest.fn();
        publicChannel.error(errorSpy);
        const conn = watchConnection();

        mockAuthServer.clientId = 'user2';
        conn.arm();
        await recovered(conn, () => 'user2');

        const ms = conn.recoveryMs() ?? Infinity;
        console.log(`user1 -> user2 recovery: ${ms} ms, states: ${conn.states.join(',')}`);
        expect(ms).toBeLessThan(5000);
        expect(conn.count('failed')).toBe(0);
        expect(await pagePublishSeenAs(seen, 'public:x')).toBe('user2');
        await expectReceives(publicChannel, 'r3');
        expect(errorSpy).not.toHaveBeenCalled(); // no 40102 reaches the app
        if (privateChannel) {
            // ably-js re-attaches it with user2's token, which lacks the channel (40160, not reported); Echo
            // re-authorizes it for user2, as after an in-page switch: no error() at all
            await attached(privateChannel);
            await sleep(1000);
            const codes = privateErrors.map((e) => e?.reason?.code ?? e?.code);
            console.log(`user1 -> user2 private error() sequence: ${codes.join(',')}`);
            expect(privateErrors).toStrictEqual([]);
        }
        await expectNoUnhandledRejections();
    });

    test('guest id -> user1: reconnects as user1 in under 5 s, then a private channel attaches', async () => {
        mockAuthServer.guestClientId = true;
        echo = makeEcho();
        await connected();
        expect(echo.connector.ably.auth.clientId).toBe(mockAuthServer.guestId);
        const publicChannel = echo.channel('r4') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const errorSpy = jest.fn();
        publicChannel.error(errorSpy);
        const conn = watchConnection();

        mockAuthServer.clientId = 'user1';
        conn.arm();
        await recovered(conn, () => 'user1');

        const ms = conn.recoveryMs() ?? Infinity;
        console.log(`guest -> user1 recovery: ${ms} ms, states: ${conn.states.join(',')}`);
        expect(ms).toBeLessThan(5000);
        expect(conn.count('failed')).toBe(0);
        const privateChannel = echo.private('r4') as AblyPrivateChannel;
        await new Promise((resolve) => privateChannel.subscribed(resolve));
        await attached(privateChannel);
        await attached(publicChannel);
        expect(echo.connector.ably.auth.clientId).toBe('user1');
        expect(errorSpy).not.toHaveBeenCalled();
        await expectNoUnhandledRejections();
    });

    test('null -> user1: unchanged ably-js path, ends connected as user1 without failed or error()', async () => {
        echo = makeEcho();
        await connected();
        expect(echo.connector.ably.auth.clientId).toBeFalsy();
        const publicChannel = echo.channel('r5') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const errorSpy = jest.fn();
        publicChannel.error(errorSpy);
        const conn = watchConnection();

        mockAuthServer.clientId = 'user1';
        conn.arm();
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'), 40000, 250);
        await connected();
        await attached(publicChannel);
        console.log(`null -> user1 states: ${conn.states.join(',')}`);
        expect(conn.count('failed')).toBe(0);
        expect(errorSpy).not.toHaveBeenCalled();
        await expectNoUnhandledRejections();
    });

    /** Wait through at least one renewal and assert Echo did not switch identity. */
    const expectNoSwitchOnSameIdentity = async (expectedId: () => string | null, channelName: string) => {
        await connected();
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId ?? null).toBe(expectedId()));
        const publicChannel = echo.channel(channelName) as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const errorSpy = jest.fn();
        publicChannel.error(errorSpy);
        const client = echo.connector.ably;
        const authorizeSpy = jest.spyOn(client.auth, 'authorize');
        const connectionId = client.connection.id;
        const clientId = client.auth.clientId;
        const conn = watchConnection();
        const firstToken = echo.connector.ablyAuth.existingToken()?.token;
        // tokenExpiry is 6 s: wait until the token has been renewed at least once, plus a margin
        await waitForExpect(() => expect(echo.connector.ablyAuth.existingToken()?.token).not.toBe(firstToken), 30000, 250);
        await sleep(3000);
        console.log(
            `same identity: token renewed, states: ${conn.states.join(',')}, ` +
                `connection.id unchanged: ${client.connection.id === connectionId}`
        );
        expect(authorizeSpy).not.toHaveBeenCalled();
        expect(conn.count('failed')).toBe(0);
        expect(client.auth.clientId).toBe(clientId);
        expect(client.connection.state).toBe('connected');
        expect(client.connection.id).toBe(connectionId);
        expect(errorSpy).not.toHaveBeenCalled();
        await expectNoUnhandledRejections();
    };

    test('user1 -> user1 renewal does not switch: no authorize(), same connection, no failed', async () => {
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await expectNoSwitchOnSameIdentity(() => 'user1', 'r6');
    });

    test('guest id -> same guest id renewal does not switch: no authorize(), same connection, no failed', async () => {
        mockAuthServer.guestClientId = true;
        echo = makeEcho();
        await expectNoSwitchOnSameIdentity(() => mockAuthServer.guestId, 'r7');
    });
});
