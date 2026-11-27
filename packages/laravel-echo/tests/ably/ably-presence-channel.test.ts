import { vi, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vite-plus/test";
import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyPresenceChannel } from '../../src/channel';
import safeAssert from './setup/utils';
import type { PresenceMessage } from '../../src/types/ably';

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

let channelCounter = 0;
// Unique per test and per run: a previous test's connection may still be a member of a shared channel for a moment.
const uniqueChannel = (label: string) => `${label}-${Date.now()}-${++channelCounter}`;

describe('AblyPresenceChannel', () => {
    let testApp: any;
    let mockAuthServer: MockAuthServer;
    let echo: Echo<'ably'>;

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

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            echo.disconnect();
            echo.connector.ably.connection.once('closed', () => {
                resolve();
            });
        });
    });

    test('channel subscription', () => new Promise<void>((resolve) => {
        const presenceChannel = echo.join(uniqueChannel('subscription')) as AblyPresenceChannel;
        presenceChannel.subscribed(() => {
            presenceChannel.unregisterSubscribed();
            resolve();
        });
    }));

    test('channel member list change', () => new Promise<void>((resolve, reject) => {
        const presenceChannel = echo.join(uniqueChannel('list')) as AblyPresenceChannel;
        presenceChannel.here((members: Array<{ id: string; name: string }>, err: unknown) => {
            safeAssert(
                () => {
                    expect(err).toBeFalsy();
                    expect(members).toHaveLength(1);
                    expect(members[0].id).toBe('sacOO7@github.com');
                    expect(members[0].name).toBe('sacOO7');
                    expect(members[0]).toStrictEqual({ id: 'sacOO7@github.com', name: 'sacOO7' });
                },
                { resolve, reject },
                true
            );
        });
    }));

    test('member joined', () => new Promise<void>((resolve, reject) => {
        const presenceChannel = echo.join(uniqueChannel('joined')) as AblyPresenceChannel;
        presenceChannel.joining((memberData: unknown, memberMetaData: Omit<PresenceMessage, 'data'>) => {
            safeAssert(
                () => {
                    expect(memberData).toStrictEqual({ id: 'sacOO7@github.com', name: 'sacOO7' });
                    expect(memberMetaData.clientId).toBe('sacOO7@github.com');
                },
                { resolve, reject },
                true
            );
        });
    }));

    test('member left', () => new Promise<void>((resolve, reject) => {
        const presenceChannel = echo.join(uniqueChannel('left')) as AblyPresenceChannel;
        presenceChannel.leaving((memberData: unknown, memberMetaData: Omit<PresenceMessage, 'data'>) => {
            safeAssert(
                () => {
                    expect(memberData).toStrictEqual({ name: 'sacOO7 leaving the channel' });
                    expect(memberMetaData.clientId).toBe('sacOO7@github.com');
                },
                { resolve, reject },
                true
            );
        });
        presenceChannel.joining(() => presenceChannel.leave({ name: 'sacOO7 leaving the channel' }));
    }));
});
