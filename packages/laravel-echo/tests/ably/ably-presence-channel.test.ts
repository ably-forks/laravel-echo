import { vi, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vite-plus/test";
import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyPresenceChannel } from '../../src/channel';
import safeAssert from './setup/utils';

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

let channelCounter = 0;
// Unique per test and per run: a previous test's connection may still be a member of a shared channel for a moment.
const uniqueChannel = (label: string) => `${label}-${Date.now()}-${++channelCounter}`;

describe('AblyPresenceChannel', () => {
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
        echo = new Echo({
            broadcaster: 'ably',
            useTls: true,
            endpoint: 'nonprod:sandbox',
            requestTokenFn: mockAuthServer.getSignedToken,
        });
    });

    afterEach((done) => {
        echo.disconnect();
        echo.connector.ably.connection.once('closed', () => {
            done();
        });
    });

    test('channel subscription', (done) => {
        const presenceChannel = echo.join(uniqueChannel('subscription')) as AblyPresenceChannel;
        presenceChannel.subscribed(() => {
            presenceChannel.unregisterSubscribed();
            done();
        });
    });

    test('channel member list change', (done) => {
        const presenceChannel = echo.join(uniqueChannel('list')) as AblyPresenceChannel;
        presenceChannel.here((members, err) => {
            safeAssert(
                () => {
                    expect(err).toBeFalsy();
                    expect(members).toHaveLength(1);
                    expect(members[0].id).toBe('sacOO7@github.com');
                    expect(members[0].name).toBe('sacOO7');
                    expect(members[0]).toStrictEqual({ id: 'sacOO7@github.com', name: 'sacOO7' });
                },
                done,
                true
            );
        });
    });

    test('member joined', (done) => {
        const presenceChannel = echo.join(uniqueChannel('joined')) as AblyPresenceChannel;
        presenceChannel.joining((memberData, memberMetaData) => {
            safeAssert(
                () => {
                    expect(memberData).toStrictEqual({ id: 'sacOO7@github.com', name: 'sacOO7' });
                    expect(memberMetaData.clientId).toBe('sacOO7@github.com');
                },
                done,
                true
            );
        });
    });

    test('member left', (done) => {
        const presenceChannel = echo.join(uniqueChannel('left')) as AblyPresenceChannel;
        presenceChannel.leaving((memberData, memberMetaData) => {
            safeAssert(
                () => {
                    expect(memberData).toStrictEqual({ name: 'sacOO7 leaving the channel' });
                    expect(memberMetaData.clientId).toBe('sacOO7@github.com');
                },
                done,
                true
            );
        });
        presenceChannel.joining(() => presenceChannel.leave({ name: 'sacOO7 leaving the channel' }));
    });
});
