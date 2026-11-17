/**
 * Connection token renewal with the fixed laravel-broadcaster (MockAuthServer renewalMode 'reverify', the default):
 * a renewal request ({channel_name: null, token: <valid token>}) gets a fresh iat/exp, with the public claims plus the
 * presented private/presence channels that are still authorized. Before the fix the broadcaster reused the presented
 * token's iat/exp, so every "renewed" token was byte-identical, ably-js (which asks to re-authorize 30 s before expiry)
 * looped on AUTH for the last 30 s, then the server closed the connection with 40142 and the page reconnected.
 *
 * Token lifetime: at least 30 s. Ably asks a connected client to re-authorize 30 s before the token expires, so a
 * token of 30 s or less is always inside that window and loops by design, whatever the broadcaster does. These tests
 * use 60 s, so a renewal starts after ~30 s and each renewed token lasts another 60 s.
 *
 * jest.mock('ws') counts the sockets; it applies to the whole file, hence this file is separate.
 */
// first: it also counts the global WebSocket, which the browser build uses, before ably is loaded
import { recordedSockets, resetRecordedSockets } from './setup/ws-counter';
import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyChannel } from '../../src/channel';
import { parseJwt } from '../../src/channel/ably/utils';
import { createClient } from '@ably/pubsub-device';
import waitForExpect from 'wait-for-expect';

// eslint-disable-next-line @typescript-eslint/no-var-requires
jest.mock('ws', () => require('./setup/ws-counter').createCountingWs(jest.requireActual('ws')));

const TOKEN_EXPIRY_S = 60; // >= 30, see above
const RENEWALS = 4; // observe several renewals
// Echo's own sockets only: the observer client (an Ably client with the API key) opens its own. Compare counts, so a
// failure never prints a socket URL (it carries a token).
const echoSocketCount = () => recordedSockets().filter((x) => x.url.includes('laravel-echo')).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

jest.setTimeout(240000);
describe('Token renewal (reverify)', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echo: Echo;
    let observer: any;
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
        mockAuthServer.renewalMode = 'reverify';
        mockAuthServer.revoked.clear();
        resetRecordedSockets();
        echo = new Echo({
            broadcaster: 'ably',
            useTls: true,
            endpoint: 'nonprod:sandbox',
            useBinaryProtocol: false,
            requestTokenFn: async (channelName, existingToken) => {
                const response = await mockAuthServer.getSignedToken(channelName, existingToken);
                tokenRequests.push({ channelName, existingToken, token: response.token });
                return response;
            },
        } as any);
    });

    afterEach(async () => {
        observer?.close();
        observer = undefined;
        echo.disconnect();
        await new Promise<void>((resolve) => echo.connector.ably.connection.once('closed', () => resolve()));
    });

    const renewalRequests = () => tokenRequests.filter((r) => r.channelName === null && r.existingToken);
    const expOf = (token: string) => parseJwt(token).payload.exp as number;
    const is403 = (e: any) => e?.code === 40300 || e?.statusCode === 403 || e?.reason?.code === 40300;

    const watch = (ch: AblyChannel) => {
        const changes: any[] = [];
        ch.channel.on((stateChange: any) => changes.push(stateChange));
        return changes;
    };

    test(`${RENEWALS} renewals on one connection: fresh tokens, no 40142, channels stay attached, no presence leave`, async () => {
        const ablyClient = echo.connector.ably;
        const states: Array<{ current: string; code?: number }> = [];
        ablyClient.connection.on((c: any) => states.push({ current: c.current, code: c.reason?.code }));
        const privateChannel = echo.private('renewal') as AblyChannel;
        const presenceChannel = echo.join('renewal') as any;
        const errors: any[] = [];
        privateChannel.error((e: any) => errors.push(e));
        presenceChannel.error((e: any) => errors.push(e));
        await Promise.all([privateChannel, presenceChannel].map((c) => new Promise((resolve) => c.subscribed(resolve))));
        const privateChanges = watch(privateChannel);
        const presenceChanges = watch(presenceChannel);

        observer = createClient({ key: testApp.keys[0].keyStr, endpoint: 'nonprod:sandbox' } as any);
        const members: Array<{ action: string; clientId: string }> = [];
        await observer.channels.get('presence:renewal').presence.subscribe((m: any) => members.push({ action: m.action, clientId: m.clientId }));

        await waitForExpect(() => expect(renewalRequests().length).toBeGreaterThanOrEqual(RENEWALS), 200000, 1000);
        await sleep(2000);

        const exps = renewalRequests().map((r) => expOf(r.token));
        console.log(`renewal exps: ${exps.join(',')}; auth requests: ${tokenRequests.length}`);
        for (let i = 1; i < exps.length; i++) expect(exps[i]).toBeGreaterThan(exps[i - 1]); // fresh exp each time
        // no AUTH loop: a few requests per renewal, not one every ~200 ms
        expect(tokenRequests.length).toBeLessThan(10 + RENEWALS * 4);
        const caps = parseJwt(renewalRequests()[0].token).payload['x-ably-capability'];
        expect(caps).toContain('"private:renewal"');
        expect(caps).toContain('"presence:renewal"');

        expect(echoSocketCount()).toBe(1);
        expect(states.map((s) => s.current)).not.toContain('disconnected');
        expect(states.filter((s) => s.code === 40142)).toEqual([]);
        expect(ablyClient.connection.state).toBe('connected');
        for (const changes of [privateChanges, presenceChanges]) {
            expect(changes.filter((c) => c.reason?.code === 40160)).toEqual([]);
            expect(changes.map((c) => c.current)).not.toContain('failed');
        }
        expect(privateChannel.channel.state).toBe('attached');
        expect(presenceChannel.channel.state).toBe('attached');
        expect(errors).toEqual([]);
        expect(members.filter((m) => m.action === 'leave')).toEqual([]);
    });

    test('a revoked private channel is dropped at the next renewal: one 403 reaches error(), the other channels stay attached', async () => {
        const privateChannel = echo.private('revoked') as AblyChannel;
        const keptChannel = echo.private('kept') as AblyChannel;
        const privateErrors: any[] = [];
        const keptErrors: any[] = [];
        privateChannel.error((e: any) => privateErrors.push(e));
        keptChannel.error((e: any) => keptErrors.push(e));
        await Promise.all([privateChannel, keptChannel].map((c) => new Promise((resolve) => c.subscribed(resolve))));

        mockAuthServer.revoke('private:revoked');
        const before = renewalRequests().length;
        await waitForExpect(() => expect(renewalRequests().length).toBeGreaterThan(before), 60000, 500);
        await waitForExpect(() => expect(privateErrors.filter(is403).length).toBeGreaterThanOrEqual(1), 30000, 500);
        await sleep(5000);

        // ably-js's own channel failure (40160: the server detaches the channel when the renewed token drops it) reaches
        // error() first, then exactly one 403 (40300) when Echo's re-authorization is refused; nothing else
        expect(privateErrors.map((e) => e?.reason?.code ?? e?.code)).toEqual([40160, 40300]);
        expect(privateChannel.channel.state).not.toBe('attached');
        expect(keptChannel.channel.state).toBe('attached');
        expect(keptErrors).toEqual([]);
        expect(echo.connector.ably.connection.state).toBe('connected');
        expect(echoSocketCount()).toBe(1);
    });
});
