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

    /**
     * Records connection state transitions and the recovery time from the first non-connected state after the
     * switch starts. ably-js also emits `update` events (previous === current, e.g. after a successful in-band
     * re-authentication); they are not transitions and are ignored.
     */
    const watchConnection = () => {
        const states: string[] = [];
        const failedCodes: any[] = [];
        let armed = false;
        let firstDown: number | null = null;
        let recoveredAt: number | null = null;
        echo.connector.ably.connection.on((change: any) => {
            if (change.previous === change.current) return;
            states.push(change.current);
            if (change.current === 'failed') failedCodes.push(change.reason?.code);
            if (!armed) return;
            if (change.current !== 'connected' && firstDown === null) firstDown = Date.now();
            if (change.current === 'connected' && firstDown !== null) recoveredAt = Date.now();
        });
        return {
            states,
            arm: () => (armed = true),
            count: (s: string) => states.filter((x) => x === s).length,
            failedCodes,
            recoveryMs: () => (firstDown !== null && recoveredAt !== null ? recoveredAt - firstDown : null),
        };
    };

    /**
     * Path-agnostic: a renewal arrives either as a disconnect (40142) or, when Ably asks the connected client to
     * re-authenticate, as an in-band AUTH; a switch on the latter passes through `failed` with 40102 once.
     */
    const expectAtMostOneSwitchFailure = (conn: ReturnType<typeof watchConnection>) => {
        expect(conn.failedCodes.filter((code) => code !== 40102)).toHaveLength(0);
        expect(conn.failedCodes.length).toBeLessThanOrEqual(1);
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
        const presenceChannel = echo.join('r1') as any;
        // register before any await: a channel can attach (and emit `subscribed`) while another is awaited
        const subscribedAll = Promise.all([publicChannel, privateChannel, presenceChannel].map((c) => new Promise((resolve) => c.subscribed(resolve))));
        await subscribedAll;
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const seen = await observe('public:x');
        const publicErrors = jest.fn();
        const privateErrors: any[] = [];
        const presenceErrors: any[] = [];
        publicChannel.error(publicErrors);
        privateChannel.error((e: any) => privateErrors.push(e));
        presenceChannel.error((e: any) => presenceErrors.push(e));
        const conn = watchConnection();

        mockAuthServer.guestClientId = true;
        mockAuthServer.clientId = null;
        conn.arm();
        await recovered(conn, () => mockAuthServer.guestId);

        const ms = conn.recoveryMs() ?? Infinity;
        console.log(`user1 -> guest recovery: ${ms} ms, states: ${conn.states.join(',')}`);
        expect(ms).toBeLessThan(5000);
        expectAtMostOneSwitchFailure(conn);
        expect(await pagePublishSeenAs(seen, 'public:x')).toBe(mockAuthServer.guestId);
        await expectReceives(publicChannel, 'r1');
        await waitForExpect(() => expect(privateErrors.length).toBeGreaterThanOrEqual(1));
        await waitForExpect(() => expect(presenceErrors.length).toBeGreaterThanOrEqual(1));
        await sleep(1000);
        expectOne403(privateErrors);
        expectOne403(presenceErrors);
        expect(publicErrors).not.toHaveBeenCalled();
        expectAtMostOneSwitchFailure(conn);
        await expectNoUnhandledRejections();
    });

    test('user1 -> null: reconnects as an anonymous client, server no longer attributes it to user1, private gets one 403', async () => {
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const publicChannel = echo.channel('r2') as AblyChannel;
        const privateChannel = echo.private('r2') as AblyPrivateChannel;
        const presenceChannel = echo.join('r2') as any;
        // register before any await: a channel can attach (and emit `subscribed`) while another is awaited
        const subscribedAll = Promise.all([publicChannel, privateChannel, presenceChannel].map((c) => new Promise((resolve) => c.subscribed(resolve))));
        await subscribedAll;
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const seen = await observe('public:x');
        const publicErrors = jest.fn();
        const privateErrors: any[] = [];
        const presenceErrors: any[] = [];
        publicChannel.error(publicErrors);
        privateChannel.error((e: any) => privateErrors.push(e));
        presenceChannel.error((e: any) => presenceErrors.push(e));
        const conn = watchConnection();

        mockAuthServer.clientId = null; // guestClientId stays false
        conn.arm();
        await recovered(conn, () => null);

        console.log(`user1 -> null recovery: ${conn.recoveryMs()} ms, states: ${conn.states.join(',')}`);
        expect(conn.recoveryMs() ?? Infinity).toBeLessThan(5000);
        expect(echo.connector.ably.auth.clientId).toBeFalsy();
        expectAtMostOneSwitchFailure(conn);
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
        await waitForExpect(() => expect(presenceErrors.length).toBeGreaterThanOrEqual(1));
        await sleep(1000);
        expectOne403(privateErrors);
        expectOne403(presenceErrors);
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
        expectAtMostOneSwitchFailure(conn);
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
        const seen = await observe('public:x');
        const conn = watchConnection();

        mockAuthServer.clientId = 'user1';
        conn.arm();
        await recovered(conn, () => 'user1');

        const ms = conn.recoveryMs() ?? Infinity;
        console.log(`guest -> user1 recovery: ${ms} ms, states: ${conn.states.join(',')}`);
        expect(ms).toBeLessThan(5000);
        expectAtMostOneSwitchFailure(conn);
        expect(await pagePublishSeenAs(seen, 'public:x')).toBe('user1');
        const privateChannel = echo.private('r4') as AblyPrivateChannel;
        await new Promise((resolve) => privateChannel.subscribed(resolve));
        await attached(privateChannel);
        await attached(publicChannel);
        expect(echo.connector.ably.auth.clientId).toBe('user1');
        expect(errorSpy).not.toHaveBeenCalled();
        await expectNoUnhandledRejections();
    });

    test('null -> user1: unchanged ably-js path, ends connected as user1 without error()', async () => {
        echo = makeEcho();
        await connected();
        expect(echo.connector.ably.auth.clientId).toBeFalsy();
        const publicChannel = echo.channel('r5') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const errorSpy = jest.fn();
        publicChannel.error(errorSpy);
        const seen = await observe('public:x');
        const conn = watchConnection();

        mockAuthServer.clientId = 'user1';
        conn.arm();
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'), 40000, 250);
        await connected();
        await attached(publicChannel);
        expect(await pagePublishSeenAs(seen, 'public:x')).toBe('user1');
        expectAtMostOneSwitchFailure(conn);
        console.log(`null -> user1 states: ${conn.states.join(',')}`);
        expect(errorSpy).not.toHaveBeenCalled();
        await expectNoUnhandledRejections();
    });

    /**
     * The in-band renewal path (Ably asks a connected client to re-authenticate about 30 s before expiry, so the
     * connection is never disconnected with 40142). Forced here: right after the mock switches identity, authorize()
     * is called, so the in-band AUTH carries the new identity (the validator's force-auth trick).
     */
    test('in-band renewal user1 -> guest id: connects as the guest, exactly one 403 on the private and one on the presence channel', async () => {
        mockAuthServer.tokenExpiry = 60; // no timed renewal during the test: the only transition is the forced authorize()
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const publicChannel = echo.channel('h1') as AblyChannel;
        const privateChannel = echo.private('h1') as AblyPrivateChannel;
        const presenceChannel = echo.join('h1') as any;
        // register before any await: a channel can attach (and emit `subscribed`) while another is awaited
        const subscribedAll = Promise.all([publicChannel, privateChannel, presenceChannel].map((c) => new Promise((resolve) => c.subscribed(resolve))));
        await subscribedAll;
        await attached(publicChannel);
        await attached(privateChannel);
        await attached(presenceChannel);
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const seen = await observe('public:x');
        const publicErrors = jest.fn();
        const privateErrors: any[] = [];
        const presenceErrors: any[] = [];
        publicChannel.error(publicErrors);
        privateChannel.error((e: any) => privateErrors.push(e));
        presenceChannel.error((e: any) => presenceErrors.push(e));
        const conn = watchConnection();

        mockAuthServer.guestClientId = true;
        mockAuthServer.clientId = null;
        conn.arm();
        await echo.connector.ably.auth.authorize().catch(() => undefined);
        await recovered(conn, () => mockAuthServer.guestId);

        console.log(`in-band user1 -> guest recovery: ${conn.recoveryMs()} ms, states: ${conn.states.join(',')}`);
        expect(echo.connector.ably.auth.clientId).toBe(mockAuthServer.guestId);
        expect(await pagePublishSeenAs(seen, 'public:x')).toBe(mockAuthServer.guestId);
        await waitForExpect(() => expect(privateErrors.length).toBeGreaterThanOrEqual(1));
        await waitForExpect(() => expect(presenceErrors.length).toBeGreaterThanOrEqual(1));
        await sleep(1500);
        expectOne403(privateErrors);
        expectOne403(presenceErrors);
        expect(publicErrors).not.toHaveBeenCalled();
        console.log(`in-band final states: ${conn.states.join(',')}`);
        expectAtMostOneSwitchFailure(conn);
        expect(conn.count('connected')).toBe(1); // update events (in-band re-authentication) are not counted
        await expectNoUnhandledRejections();
    });

    test('in-band renewal user1 -> user2: connects as user2, no error() on any channel, at most one failed, one connected', async () => {
        mockAuthServer.tokenExpiry = 60;
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await connected();
        const privateChannel = echo.private('h2') as AblyPrivateChannel;
        const presenceChannel = echo.join('h2') as any;
        // register before any await: a channel can attach (and emit `subscribed`) while another is awaited
        const subscribedAll = Promise.all([privateChannel, presenceChannel].map((c) => new Promise((resolve) => c.subscribed(resolve))));
        await subscribedAll;
        await attached(privateChannel);
        await attached(presenceChannel);
        await waitForExpect(() => expect(echo.connector.ably.auth.clientId).toBe('user1'));
        const privateErrors: any[] = [];
        const presenceErrors: any[] = [];
        privateChannel.error((e: any) => privateErrors.push(e));
        presenceChannel.error((e: any) => presenceErrors.push(e));
        const conn = watchConnection();

        mockAuthServer.clientId = 'user2';
        conn.arm();
        await echo.connector.ably.auth.authorize().catch(() => undefined);
        await recovered(conn, () => 'user2');
        await attached(privateChannel);
        await attached(presenceChannel);
        await sleep(1500);

        console.log(`in-band user1 -> user2 recovery: ${conn.recoveryMs()} ms, states: ${conn.states.join(',')}`);
        console.log(`in-band user1 -> user2 error() codes: private=[${privateErrors.map((e) => e?.reason?.code ?? e?.code)}] presence=[${presenceErrors.map((e) => e?.reason?.code ?? e?.code)}]`);
        expect(echo.connector.ably.auth.clientId).toBe('user2');
        expect(privateErrors).toStrictEqual([]);
        expect(presenceErrors).toStrictEqual([]);
        console.log(`in-band final states: ${conn.states.join(',')}`);
        expectAtMostOneSwitchFailure(conn);
        expect(conn.count('connected')).toBe(1); // update events (in-band re-authentication) are not counted
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
        // Echo's switch authorizes with the token and clientId: null. ably-js's own re-authentication, when Ably asks
        // for it in-band, calls authorize() without arguments: that is not a switch.
        expect(authorizeSpy.mock.calls.filter(([, options]: any[]) => options && 'clientId' in options)).toHaveLength(0);
        expect(conn.count('failed')).toBe(0);
        expect(client.auth.clientId).toBe(clientId);
        expect(client.connection.state).toBe('connected');
        expect(client.connection.id).toBe(connectionId);
        expect(errorSpy).not.toHaveBeenCalled();
        await expectNoUnhandledRejections();
    };

    test('user1 -> user1 renewal does not switch: no switch authorize(), same connection, no failed', async () => {
        mockAuthServer.clientId = 'user1';
        echo = makeEcho();
        await expectNoSwitchOnSameIdentity(() => 'user1', 'r6');
    });

    test('guest id -> same guest id renewal does not switch: no switch authorize(), same connection, no failed', async () => {
        mockAuthServer.guestClientId = true;
        echo = makeEcho();
        await expectNoSwitchOnSameIdentity(() => mockAuthServer.guestId, 'r7');
    });
});
