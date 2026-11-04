/**
 * R17: coverage gaps. (_attach patch applied on the real library, listener metadata key sets, options.client path.)
 * R17.1 (no-token guard) and R17.3 (wrong-global error) are covered by auth-token-path / connector-options tests,
 * R17.6 by http-request.test.ts, R17.7 by export-surface.test.ts plus the CI dist check.
 */
import * as Ably from '@ably/pubsub-device';
import Echo from '../../src/echo';
import { AblyChannel, AblyPresenceChannel } from '../../src/channel';
import { setup, tearDown } from './setup/sandbox';
import { MockAuthServer } from './setup/mock-auth-server';

jest.setTimeout(30000);

describe('coverage gaps (R17)', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;

    beforeAll(async () => {
        global.Ably = Ably;
        testApp = await setup();
        mockAuthServer = new MockAuthServer(testApp.keys[0].keyStr);
    });

    afterAll(async () => tearDown(testApp));

    const makeEcho = (extra: any = {}) =>
        new Echo({ broadcaster: 'ably', endpoint: 'nonprod:sandbox', requestTokenFn: mockAuthServer.getSignedToken, ...extra });

    test('R17.2 the pre-attach authorize patch is applied to the v3 RealtimeChannel prototype', () => {
        const echo = makeEcho({ autoConnect: false });
        const proto = Object.getPrototypeOf(echo.connector.ably.channels.get('anything'));
        expect(proto._attach.name).toBe('customInternalAttach');
        echo.disconnect();
    });

    test('R17.4 listen() metadata key set (guards accidental changes of the (data, meta) payload)', async () => {
        const echo = makeEcho();
        const meta: any = await new Promise((resolve) => {
            const channel = echo.channel('meta') as AblyChannel;
            channel
                .subscribed(() => mockAuthServer.broadcast('public:meta', 'App\\Events\\testEvent', 'hi'))
                .listen('testEvent', (_data, m) => resolve(m));
        });
        // Key set for this publish shape (REST publish, no clientId/extras); keys such as clientId/extras appear only when set.
        // Explicit list rather than toMatchSnapshot(): CI runs jest with --ci, which never writes new snapshots.
        expect(Object.keys(meta).sort()).toEqual(
            ['action', 'annotations', 'connectionId', 'encoding', 'id', 'name', 'serial', 'timestamp', 'version']
        );
        echo.disconnect();
    });

    test('R17.4 joining() presence metadata key set', async () => {
        const echo = makeEcho();
        const other = makeEcho();
        const meta: any = await new Promise((resolve) => {
            const channel = echo.join('meta') as AblyPresenceChannel;
            channel.joining((_data, m) => resolve(m));
            channel.subscribed(() => other.join('meta'));
        });
        expect(Object.keys(meta).sort()).toEqual(['action', 'clientId', 'connectionId', 'encoding', 'id', 'timestamp']);
        echo.disconnect();
        other.disconnect();
    });

    test('R17.5 options.client: a user-built client is used as is and public channels work', async () => {
        const client = Ably.createClient({ key: testApp.keys[0].keyStr, endpoint: 'nonprod:sandbox' });
        const echo = new Echo({ broadcaster: 'ably', client });
        expect(echo.connector.ably).toBe(client);
        expect(echo.connector.ablyAuth).toBeUndefined(); // see P3: private()/join()/leaveChannel() need ablyAuth today
        const data = await new Promise((resolve) => {
            const channel = echo.channel('client') as AblyChannel;
            channel
                .subscribed(() => mockAuthServer.broadcast('public:client', 'App\\Events\\testEvent', 'via options.client'))
                .listen('testEvent', resolve);
        });
        expect(data).toBe('via options.client');
        client.close();
    });
});
