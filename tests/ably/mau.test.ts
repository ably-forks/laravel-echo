/**
 * MAU (monthly active users) behaviour of Echo, against a normal sandbox app behind MauProxy, which emulates the MAU
 * rule "a connection needs an identified client" (40161 for a null or '*' clientId). Only Echo goes through the proxy:
 * the mock auth server talks to the sandbox directly.
 *
 * TODO: replace this mock with a real MAU sandbox app when Ably provides one. Never use a real MAU key.
 *
 * Skip behaviour: the other sandbox suites have no skip mechanism (an unreachable sandbox fails their beforeAll).
 * Locally, beforeAll remembers the reason and each test returns early with a console.warn instead; in CI
 * (`process.env.CI`) an unreachable sandbox fails the suite.
 */
import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { MauProxy } from './setup/mau-proxy';
import { AblyChannel, AblyPrivateChannel } from '../../src/channel';
import { trackUnhandledRejections } from '../parity/fake-ably';
import waitForExpect from 'wait-for-expect';

jest.setTimeout(45000);

describe('MAU account (mock proxy)', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let proxy: MauProxy;
    let echo: Echo | undefined;
    let errorSpy: jest.SpyInstance;
    let skipReason: string | undefined;
    let ready = false; // beforeAll completed: the per-test hooks only run then, so a setup failure is the only error

    const skipped = () => {
        if (skipReason) {
            console.warn(`MAU suite skipped: sandbox unreachable: ${skipReason}`);
        }
        return !!skipReason;
    };
    const connectEcho = () =>
        new Echo({
            broadcaster: 'ably',
            endpoint: 'localhost',
            port: proxy.port,
            tls: false,
            fallbackHosts: [],
            useBinaryProtocol: false,
            requestTokenFn: mockAuthServer.getSignedToken,
            echoMessages: true,
        });
    const hintCalls = () => errorSpy.mock.calls.filter((call) => String(call[0]).includes('40161'));
    const connected = (e: Echo) => waitForExpect(() => expect(e.connector.ably.connection.state).toBe('connected'));

    beforeAll(async () => {
        try {
            testApp = await setup();
        } catch (err: any) {
            const code = err?.code ?? err?.cause?.code;
            const unreachable = code === 50000 || code === 50003 || /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|ETIMEDOUT/i.test(String(err?.message));
            if (!unreachable || process.env.CI) {
                throw err; // in CI an unreachable sandbox fails the suite, as it does for the other sandbox suites
            }
            skipReason = String(err?.message ?? err);
            return;
        }
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
        proxy = await new MauProxy().start();
        ready = true;
    });

    afterAll(async () => {
        if (proxy) {
            await proxy.stop();
        }
        if (testApp) {
            await tearDown(testApp);
        }
    });

    beforeEach(() => {
        if (!ready) {
            return;
        }
        proxy.rejected = 0;
        mockAuthServer.clientId = null;
        mockAuthServer.guestClientId = false;
        mockAuthServer.rotateGuestId();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        if (!ready) {
            return;
        }
        errorSpy.mockRestore();
        echo?.disconnect();
        echo = undefined;
    });

    test('a null guest is rejected with 40161 and Echo logs the hint once', async () => {
        if (skipped()) return;
        echo = connectEcho();
        const ably = echo.connector.ably;
        await waitForExpect(() => expect(ably.connection.state).toBe('failed'));
        expect(ably.connection.errorReason?.code).toBe(40161);
        expect(proxy.rejected).toBeGreaterThanOrEqual(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const message = String(errorSpy.mock.calls[0][0]);
        expect(message).toContain('40161');
        expect(message).toContain('ABLY_MAU_ACCOUNT=true');
    });

    test('guest id to user login recovers without error()', async () => {
        if (skipped()) return;
        mockAuthServer.guestClientId = true;
        echo = connectEcho();
        await connected(echo);
        const guestId = echo.connector.ably.auth.clientId;
        expect(guestId).toMatch(/^guest:/);
        expect(proxy.rejected).toBe(0);

        const publicChannel = echo.channel('mau') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const publicError = jest.fn();
        publicChannel.error(publicError);

        mockAuthServer.clientId = 'user1';
        const privateChannel = echo.private('mau') as AblyPrivateChannel;
        const privateError = jest.fn();
        privateChannel.error(privateError);
        const reattached = Promise.all([
            new Promise((resolve) => publicChannel.subscribed(resolve)),
            new Promise((resolve) => privateChannel.subscribed(resolve)),
        ]);
        await reattached;
        await connected(echo);
        await waitForExpect(() => {
            expect(echo?.connector.ably.auth.clientId).toBe('user1');
            expect(publicChannel.channel.state).toBe('attached');
            expect(privateChannel.channel.state).toBe('attached');
        });

        const received = new Promise((resolve) => publicChannel.listen('.mau-event', resolve));
        await mockAuthServer.broadcast('public:mau', 'mau-event', JSON.stringify({ ok: true }));
        await received;

        expect(publicError).not.toHaveBeenCalled();
        expect(privateError).not.toHaveBeenCalled();
        expect(proxy.rejected).toBe(0);
        expect(hintCalls()).toHaveLength(0);
    });

    test('user to guest id logout recovers; private re-auth gets 403', async () => {
        if (skipped()) return;
        const rejections = trackUnhandledRejections();
        mockAuthServer.guestClientId = true;
        mockAuthServer.clientId = 'user1';
        echo = connectEcho();
        await connected(echo);
        const publicChannel = echo.channel('mau') as AblyChannel;
        await new Promise((resolve) => publicChannel.subscribed(resolve));
        const privateChannel = echo.private('mau') as AblyPrivateChannel;
        await new Promise((resolve) => privateChannel.subscribed(resolve));
        expect(echo.connector.ably.auth.clientId).toBe('user1');

        // logout: the documented in-page path is echo.connect(), which replaces the client
        const oldClient = echo.connector.ably;
        mockAuthServer.clientId = null;
        mockAuthServer.rotateGuestId();
        echo.connect();
        const newClient = echo.connector.ably;
        expect(newClient).not.toBe(oldClient);
        await waitForExpect(() => expect(newClient.connection.state).toBe('connected'));
        expect(newClient.auth.clientId).toBe(mockAuthServer.guestId);

        const guestPublic = echo.channel('mau') as AblyChannel;
        await new Promise((resolve) => guestPublic.subscribed(resolve));
        const received = new Promise((resolve) => guestPublic.listen('.mau-event', resolve));
        await mockAuthServer.broadcast('public:mau', 'mau-event', JSON.stringify({ ok: true }));
        await received;

        const guestPrivate = echo.private('mau') as AblyPrivateChannel;
        const guestErr: any = await new Promise((resolve) => guestPrivate.error(resolve));
        expect(guestErr.statusCode === 403 || guestErr.code === 40300).toBe(true);

        expect(proxy.rejected).toBe(0);
        expect(hintCalls()).toHaveLength(0);
        await new Promise((resolve) => setTimeout(resolve, 50)); // let Node emit pending unhandledRejection events
        rejections.stop();
        expect(rejections.rejections).toStrictEqual([]);
    });

    test('user to null logout without guest ids gets 40161 (MAU needs ABLY_MAU_ACCOUNT=true)', async () => {
        if (skipped()) return;
        mockAuthServer.clientId = 'user1';
        echo = connectEcho();
        await connected(echo);

        mockAuthServer.clientId = null;
        echo.connect();
        const newClient = echo.connector.ably;
        await waitForExpect(() => expect(newClient.connection.state).toBe('failed'));
        expect(newClient.connection.errorReason?.code).toBe(40161);
        expect(proxy.rejected).toBeGreaterThanOrEqual(1);
        expect(hintCalls()).toHaveLength(1);
        expect(String(hintCalls()[0][0])).toContain('ABLY_MAU_ACCOUNT=true');
    });

    describe('renewed token with another identity', () => {
        beforeEach(() => {
            if (ready) mockAuthServer.tokenExpiry = 6;
        });
        afterEach(() => {
            if (ready) mockAuthServer.tokenExpiry = 60;
        });

        test('renewal user to guest id reconnects through the proxy as the guest, without a rejection', async () => {
            if (skipped()) return;
            mockAuthServer.guestClientId = true;
            mockAuthServer.clientId = 'user1';
            echo = connectEcho();
            await connected(echo);
            const publicChannel = echo.channel('mau') as AblyChannel;
            await new Promise((resolve) => publicChannel.subscribed(resolve));
            await waitForExpect(() => expect(echo?.connector.ably.auth.clientId).toBe('user1'));

            mockAuthServer.clientId = null; // another tab logged out; the next renewed token is the guest's
            await waitForExpect(
                () => {
                    expect(echo?.connector.ably.connection.state).toBe('connected');
                    expect(echo?.connector.ably.auth.clientId).toBe(mockAuthServer.guestId);
                },
                40000,
                250,
            );
            await waitForExpect(() => expect(publicChannel.channel.state).toBe('attached'));
            const received = new Promise((resolve) => publicChannel.listen('.mau-event', resolve));
            await new Promise((resolve) => setTimeout(resolve, 200));
            await mockAuthServer.broadcast('public:mau', 'mau-event', JSON.stringify({ ok: true }));
            await received;
            expect(proxy.rejected).toBe(0);
            expect(hintCalls()).toHaveLength(0);
        });

        test('renewal user to null without guest ids is rejected with 40161 and the hint is logged once', async () => {
            if (skipped()) return;
            mockAuthServer.clientId = 'user1';
            echo = connectEcho();
            await connected(echo);
            await waitForExpect(() => expect(echo?.connector.ably.auth.clientId).toBe('user1'));
            const client = echo.connector.ably;

            mockAuthServer.clientId = null; // guestClientId stays false: MAU rejects the anonymous reconnect
            await waitForExpect(() => expect(client.connection.state).toBe('failed'), 40000, 250);
            expect(client.connection.errorReason?.code).toBe(40161);
            expect(proxy.rejected).toBeGreaterThanOrEqual(1);
            expect(hintCalls()).toHaveLength(1);
            expect(String(hintCalls()[0][0])).toContain('ABLY_MAU_ACCOUNT=true');
        });
    });
});
