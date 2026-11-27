import { vi, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vite-plus/test";
import { setup, tearDown } from './setup/sandbox';
import Echo from '../../src/echo';
import { MockAuthServer } from './setup/mock-auth-server';
import { AblyChannel, AblyPresenceChannel } from '../../src/channel';
import safeAssert, { execute } from './setup/utils';
import waitForExpect from 'wait-for-expect';

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });
describe('AblyChannel', () => {
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
        echo.channel('test').subscribed(() => {
            resolve();
        });
    }));

    test('Listen to a default broadcaster event', () => new Promise<void>((resolve, reject) => {
        const publicChannel = echo.channel('test') as AblyChannel;
        publicChannel
            .subscribed(() => {
                void mockAuthServer.broadcast('public:test', 'App\\Events\\testEvent', 'Hello there');
            })
            .listen('testEvent', (data: unknown) => {
                safeAssert(() => expect(data).toBe('Hello there'), { resolve, reject }, true);
            });
    }));

    // https://laravel.com/docs/9.x/broadcasting#broadcast-name
    test('Listen to a broadcast as event', () => new Promise<void>((resolve, reject) => {
        const publicChannel = echo.channel('test') as AblyChannel;
        publicChannel
            .subscribed(() => {
                void mockAuthServer.broadcast('public:test', 'testEvent', 'Hello there');
            })
            .listen('.testEvent', (data: unknown) => {
                safeAssert(() => expect(data).toBe('Hello there'), { resolve, reject }, true);
            });
    }));

    test('Listen to a whisper', () => new Promise<void>((resolve, reject) => {
        const publicChannel = echo.channel('test') as AblyChannel;
        publicChannel
            .subscribed(() => {
                void mockAuthServer.broadcast('public:test', 'client-msg', 'Hello there');
            })
            .listenForWhisper('msg', (data: unknown) => {
                safeAssert(() => expect(data).toBe('Hello there'), { resolve, reject }, true);
            });
    }));

    test('Listen to a notification', () => new Promise<void>((resolve, reject) => {
        const publicChannel = echo.channel('test') as AblyChannel;
        publicChannel
            .subscribed(() => {
                void mockAuthServer.broadcast(
                    'public:test',
                    'Illuminate\\Notifications\\Events\\BroadcastNotificationCreated',
                    'Hello there'
                );
            })
            .notification((data: unknown) => {
                safeAssert(() => expect(data).toBe('Hello there'), { resolve, reject }, true);
            });
    }));

    test('Listen to all events', () => new Promise<void>((resolve, reject) => {
        const publicChannel = echo.channel('test1') as AblyChannel;
        publicChannel
            .subscribed(() => {
                void mockAuthServer.broadcast('public:test1', 'testEvent', 'Hello there');
            })
            .listenToAll((eventName: string, data: unknown) => {
                safeAssert(
                    () => {
                        expect(eventName).toBe('.testEvent');
                        expect(data).toBe('Hello there');
                    },
                    { resolve, reject },
                    true
                );
            });
    }));

    test('stop listening to a event', async () => {
        const publicChannel = echo.channel('test') as AblyChannel;
        const eventHandler1 = vi.fn();
        const eventHandler2 = vi.fn();
        const eventHandler3 = vi.fn();

        await new Promise((resolve) => {
            publicChannel
                .subscribed(resolve)
                .listen('.testEvent', eventHandler1)
                .listen('.testEvent', eventHandler2)
                .listen('.testEvent', eventHandler3);
        });

        // Sentinel: a raw listener for every message, which stopListening('.testEvent') does not remove. ably calls
        // all listeners of a message synchronously, so once the sentinel has seen n testEvents, every handler still
        // subscribed has been called for them as well.
        let delivered = 0;
        let onDelivered: () => void;
        await publicChannel.channel.subscribe((message) => {
            if (message.name === 'testEvent') {
                delivered++;
                onDelivered?.();
            }
        });
        const broadcastAndWaitForDelivery = async (times: number) => {
            delivered = 0;
            const allDelivered = new Promise<void>((resolve) => {
                onDelivered = () => delivered >= times && resolve();
            });
            await Promise.all(
                Array.from({ length: times }, () => mockAuthServer.broadcast('public:test', 'testEvent', 'Hello there'))
            );
            await allDelivered;
        };

        await broadcastAndWaitForDelivery(4);

        expect(eventHandler1).toHaveBeenCalledTimes(4);
        expect(eventHandler2).toHaveBeenCalledTimes(4);
        expect(eventHandler3).toHaveBeenCalledTimes(4);

        vi.clearAllMocks();
        publicChannel.stopListening('.testEvent', eventHandler1);

        await broadcastAndWaitForDelivery(3);

        expect(eventHandler1).toHaveBeenCalledTimes(0);
        expect(eventHandler2).toHaveBeenCalledTimes(3);
        expect(eventHandler3).toHaveBeenCalledTimes(3);

        vi.clearAllMocks();
        publicChannel.stopListening('.testEvent');

        await broadcastAndWaitForDelivery(3);

        expect(eventHandler1).toHaveBeenCalledTimes(0);
        expect(eventHandler2).toHaveBeenCalledTimes(0);
        expect(eventHandler3).toHaveBeenCalledTimes(0);
    });

    // internally calls stop listening to a event
    test('stop listening to a whisper/client-event', async () => {
        const publicChannel = echo.channel('test') as AblyChannel;
        const eventHandler1 = vi.fn();
        const eventHandler2 = vi.fn();
        const eventHandler3 = vi.fn();

        await new Promise((resolve) => {
            publicChannel
                .subscribed(resolve)
                .listenForWhisper('msg', eventHandler1)
                .listenForWhisper('msg', eventHandler2)
                .listenForWhisper('msg2', eventHandler3);
        });

        execute(() => mockAuthServer.broadcast('public:test', 'client-msg', 'Hello there'), 4);
        execute(() => mockAuthServer.broadcast('public:test', 'client-msg2', 'Hello there'), 1);

        await waitForExpect(() => {
            expect(eventHandler1).toHaveBeenCalledTimes(4);
            expect(eventHandler2).toHaveBeenCalledTimes(4);
            expect(eventHandler3).toHaveBeenCalledTimes(1);
        });

        vi.clearAllMocks();
        publicChannel.stopListeningForWhisper('msg', eventHandler1);

        execute(() => mockAuthServer.broadcast('public:test', 'client-msg', 'Hello there'), 3);
        execute(() => mockAuthServer.broadcast('public:test', 'client-msg2', 'Hello there'), 2);

        await waitForExpect(() => {
            expect(eventHandler1).toHaveBeenCalledTimes(0);
            expect(eventHandler2).toHaveBeenCalledTimes(3);
            expect(eventHandler3).toHaveBeenCalledTimes(2);
        });
    });

    test('Leave channel', async () => {
        const publicChannel = echo.channel('test') as AblyChannel;
        const privateChannel = echo.private('test') as AblyChannel;
        const presenceChannel = echo.join('test') as AblyPresenceChannel;
        const publicChannelSubscription = new Promise((resolve) => publicChannel.subscribed(resolve));
        const privateChannelSubscription = new Promise((resolve) => privateChannel.subscribed(resolve));
        const presenceChannelSubscription = new Promise((resolve) => presenceChannel.subscribed(resolve));

        await Promise.all([publicChannelSubscription, privateChannelSubscription, presenceChannelSubscription]);

        echo.leave('test');

        const publicDetachPromise = new Promise((resolve) => publicChannel.channel.on('detached', resolve));
        const privateDetachPromise = new Promise((resolve) => privateChannel.channel.on('detached', resolve));
        const presenceDetachPromise = new Promise((resolve) => presenceChannel.channel.on('detached', resolve));

        await Promise.all([publicDetachPromise, privateDetachPromise, presenceDetachPromise]);
    });
});
