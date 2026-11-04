/**
 * Channel-listener and pre-attach authorization edge cases (review T13–T17, P1). Fake ably, no network.
 * Each test name carries the review finding ID.
 */
import { AblyChannel, AblyPresenceChannel, AblyPrivateChannel } from '../../src/channel';
import { AblyAuth } from '../../src/channel/ably/auth';
import { beforeChannelAttach } from '../../src/channel/ably/attach';
import { ECHO_OPTIONS, makeFakeAbly, makeJwt, settle, stubAuth, trackUnhandledRejections } from './fake-ably';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Exactly ably v3's RealtimeChannel.unsubscribe argument handling (dist/node.js:5412-5419, processListenerArgs :5145)
 * plus pubsub-core EventEmitter.off (build/index.js:253-293). ably 1.2.50 is identical (ably-node.js:1307-1342).
 * Key property: off(event, undefined) removes EVERY listener for `event`; off(undefined, undefined) removes ALL.
 */
const useAblyUnsubscribeSemantics = (fake: any) => {
    fake.unsubscribe = jest.fn((...raw: any[]) => {
        const args = [...raw];
        if (typeof args[0] === 'function') args.unshift(null);
        const [event, listener] = args;
        const em = fake.messages;
        if (event == null && listener == null) {
            em.any = [];
            em.events = {};
            return;
        }
        if (listener && event == null) {
            em.any = em.any.filter((l) => l !== listener);
            Object.keys(em.events).forEach((k) => (em.events[k] = em.events[k].filter((l) => l !== listener)));
            return;
        }
        if (listener) em.events[event] = (em.events[event] || []).filter((l) => l !== listener);
        else delete em.events[event];
    });
};

const publicChannel = () => {
    const ably = makeFakeAbly();
    const echoChannel = new AblyChannel(ably, 'public:c', ECHO_OPTIONS);
    const fake = ably.channels.get('public:c');
    useAblyUnsubscribeSemantics(fake);
    const deliver = (event: string, data: any = 1) => {
        const name = `App\\Events\\${event}`;
        fake.messages.emit(name, { name, data });
    };
    return { echoChannel, fake, deliver };
};

describe('T13: stopListening / stopListeningToAll must only remove what was registered (Pusher parity)', () => {
    test('T13a stopListening(event, cbNeverRegistered) leaves other listeners of that event alone', () => {
        const { echoChannel, deliver } = publicChannel();
        const a1 = jest.fn();
        const a2 = jest.fn();
        echoChannel.listen('A', a1).listen('A', a2);
        echoChannel.stopListening('A', () => undefined);
        deliver('A');
        expect(a1).toHaveBeenCalledTimes(1);
        expect(a2).toHaveBeenCalledTimes(1);
    });

    test('T13b calling stopListening(event, cb) twice does not remove other listeners', () => {
        const { echoChannel, deliver } = publicChannel();
        const a1 = jest.fn();
        const a2 = jest.fn();
        echoChannel.listen('A', a1).listen('A', a2);
        echoChannel.stopListening('A', a1);
        echoChannel.stopListening('A', a1); // e.g. a component cleanup that runs twice
        deliver('A');
        expect(a1).not.toHaveBeenCalled();
        expect(a2).toHaveBeenCalledTimes(1);
    });

    test('T13c stopListeningToAll(cbNeverRegistered) does not wipe every listen() listener', () => {
        const { echoChannel, deliver } = publicChannel();
        const b = jest.fn();
        echoChannel.listen('B', b);
        echoChannel.stopListeningToAll(() => undefined);
        deliver('B');
        expect(b).toHaveBeenCalledTimes(1);
    });

    test('T13d one callback on two events: stopListening(X, cb) stops X only', () => {
        const { echoChannel, deliver } = publicChannel();
        const shared = jest.fn();
        echoChannel.listen('X', shared).listen('Y', shared);
        echoChannel.stopListening('X', shared);
        deliver('X');
        deliver('Y');
        expect(shared).toHaveBeenCalledTimes(1);
        expect(shared.mock.calls[0][0]).toBe(1);
    });

    test('T13e the same callback registered twice on one event is removed by stopListening(event, cb)', () => {
        const { echoChannel, deliver } = publicChannel();
        const dupe = jest.fn();
        echoChannel.listen('D', dupe).listen('D', dupe);
        echoChannel.stopListening('D', dupe);
        deliver('D');
        expect(dupe).not.toHaveBeenCalled();
    });

    test('T13f stopListeningToAll() removes listenToAll() listeners only, not listen() ones (PusherChannel uses unbind_global)', () => {
        const { echoChannel, deliver } = publicChannel();
        const a = jest.fn();
        const all = jest.fn();
        echoChannel.listen('A', a).listenToAll(all);
        echoChannel.stopListeningToAll();
        deliver('A');
        expect(all).not.toHaveBeenCalled();
        expect(a).toHaveBeenCalledTimes(1);
    });

    test('stopListening(event, cb) for a registered cb removes exactly that listener (contract)', () => {
        const { echoChannel, deliver } = publicChannel();
        const a1 = jest.fn();
        const a2 = jest.fn();
        echoChannel.listen('A', a1).listen('A', a2);
        echoChannel.stopListening('A', a1);
        deliver('A');
        expect(a1).not.toHaveBeenCalled();
        expect(a2).toHaveBeenCalledTimes(1);
    });
});

describe('T14: listenToAll with namespace: false', () => {
    test('T14 listenToAll delivers events when the namespace option is false', () => {
        const ably = makeFakeAbly();
        const echoChannel = new AblyChannel(ably, 'public:n', { namespace: false });
        const fake = ably.channels.get('public:n');
        const cb = jest.fn();
        echoChannel.listenToAll(cb);
        fake.messages.emit('MyEvent', { name: 'MyEvent', data: { v: 1 } });
        expect(fake.messages.listenerErrors).toEqual([]); // before the T14 fix: TypeError: this.options.namespace.replace is not a function
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][1]).toEqual({ v: 1 });
    });
});

describe('T15: presence auto-enter on re-attach', () => {
    test('T15 a RESUMED re-attach does not make Echo enter again (ably RTP17 already re-enters)', async () => {
        const ably = makeFakeAbly();
        new AblyPresenceChannel(ably, 'presence:r', ECHO_OPTIONS, stubAuth);
        const fake = ably.channels.get('presence:r');
        fake.transition('attaching');
        fake.transition('attached'); // first attach: Echo must enter
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(1);
        // connection resumed: ably moves attached -> attaching -> attached(resumed) (v3 node.js:8330, 1.2.50 ably-node.js:9449)
        fake.transition('attaching');
        fake.state = 'attached';
        fake.stateEmitter.emit('attached', { previous: 'attaching', current: 'attached', resumed: true });
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(1);
    });

    test('a NON-resumed re-attach still makes Echo enter (membership may have been lost)', async () => {
        const ably = makeFakeAbly();
        new AblyPresenceChannel(ably, 'presence:r2', ECHO_OPTIONS, stubAuth);
        const fake = ably.channels.get('presence:r2');
        fake.transition('attached');
        fake.transition('attaching');
        fake.transition('attached');
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(2);
    });
});

describe('documented parity with 1.0.6 and Pusher', () => {
    test('subscribed() registered after the channel is already attached is not called retroactively', async () => {
        const ably = makeFakeAbly();
        const echoChannel = new AblyChannel(ably, 'public:s', ECHO_OPTIONS);
        const fake = ably.channels.get('public:s');
        fake.transition('attached');
        const cb = jest.fn();
        echoChannel.subscribed(cb);
        await settle();
        expect(cb).not.toHaveBeenCalled();
    });

    test('leave() issued while enter() is in flight: each callback called once', async () => {
        const ably = makeFakeAbly();
        const echoChannel = new AblyPresenceChannel(ably, 'presence:l', ECHO_OPTIONS, stubAuth);
        const fake = ably.channels.get('presence:l');
        let releaseEnter: Function;
        fake.presence.enter.mockImplementationOnce(() => new Promise((r) => (releaseEnter = r)));
        const order: string[] = [];
        echoChannel.enter({ a: 1 }, (err) => order.push(`enter:${err}`));
        echoChannel.leave({ a: 1 }, (err) => order.push(`leave:${err}`));
        await settle();
        releaseEnter();
        await settle();
        expect([...order].sort()).toEqual(['enter:null', 'leave:null']); // real ably acks in send order (xver3 N5)
        expect(fake.presence.enter).toHaveBeenCalledTimes(1);
        expect(fake.presence.leave).toHaveBeenCalledTimes(1);
    });

    test('a public channel has no whisper(), as with PusherChannel', () => {
        const ably = makeFakeAbly();
        const echoChannel: any = new AblyChannel(ably, 'public:w', ECHO_OPTIONS);
        expect(echoChannel.whisper).toBeUndefined();
    });
});

/** RealtimeChannel stand-in with just enough state for the attach patch + Echo channel classes. */
class FakeRealtimeChannel {
    name: string;
    state = 'initialized';
    authorizing?: boolean;
    attachCalls = 0;
    private listeners: Function[] = [];
    presence: any;
    constructor(name: string) {
        this.name = name;
        this.presence = { unsubscribe: jest.fn(), leave: jest.fn(() => Promise.resolve()), enter: jest.fn(() => Promise.resolve()) };
    }
    on(...a: any[]) {
        this.listeners.push(a[a.length - 1]);
    }
    once() { return undefined; }
    off() {
        this.listeners = [];
    }
    subscribe() {
        return this.attach();
    }
    unsubscribe() { return undefined; }
    attach() {
        if (this.state === 'attached') return Promise.resolve(null);
        return new Promise((resolve, reject) => this._attach(false, null, (e, r) => (e ? reject(e) : resolve(r))));
    }
    detach() {
        this.state = 'detached';
        return Promise.resolve();
    }
    /** the library's internal attach, which Echo wraps */
    _attach(_force, _reason, cb) {
        this.attachCalls++;
        this.state = 'attached';
        cb?.(null);
    }
}

describe('T16 / P1-fix review: patched _attach', () => {
    const makeClient = (requestTokenFn: Function) => {
        const channels: Record<string, FakeRealtimeChannel> = {};
        const client: any = {
            channels: { get: (n: string) => (channels[n] = channels[n] || Object.assign(new FakeRealtimeChannel(n), { client })) },
            getTimestamp: jest.fn(() => Promise.resolve(Date.now())),
            getTimestampUsingOffset: () => Date.now(),
            auth: { tokenDetails: null, authorize: jest.fn((_, o) => Promise.resolve(o.token)), clientId: 'user1' },
            connection: { on: jest.fn(), off: jest.fn() },
            connect: jest.fn(),
        };
        const connector: any = { ably: client, channels: {} };
        const auth = new AblyAuth(connector, { authEndpoint: 'http://localhost/broadcasting/auth', auth: { headers: {} }, requestTokenFn });
        auth.enableAuthorizeBeforeChannelAttach();
        return { auth, client, connector, channels };
    };

    test('T16 auth failure while an ably-internal fire-and-forget attach() is queued: no unhandled rejection', async () => {
        const t = trackUnhandledRejections();
        try {
            const { client } = makeClient(async () => {
                await wait(30);
                throw new Error('auth endpoint 403');
            });
            const ch: any = client.channels.get('presence:authfail');
            ch.attach().catch(() => undefined); // Echo's own attach (handled)
            ch.attach(); // what v3 presence.enter() does on an 'initialized' channel (node.js:8630): no handler
            await wait(100);
            expect(ch.authorizing).toBe(false);
            expect(t.rejections).toEqual([]);
        } finally {
            t.stop();
        }
    });

    test('P1 (success path) a queued attach settles after authorization succeeds', async () => {
        const { client } = makeClient(async () => ({ token: makeJwt({ 'presence:*': ['*'] }) }));
        const ch: any = client.channels.get('presence:ok');
        const first = ch.attach();
        let second = 'pending';
        ch.attach().then(() => (second = 'resolved'), () => (second = 'rejected'));
        await first;
        await settle();
        expect(second).toBe('resolved');
    });

    test('an authorizer that calls back twice cannot settle the attach twice (defensive)', async () => {
        const ch: any = new FakeRealtimeChannel('private:twice');
        const client: any = { channels: { get: () => ch } };
        ch.client = client; // the patched _attach looks the authorizer up per client
        beforeChannelAttach(client, (_c, done) => {
            done(null);
            done(new Error('late error'));
        });
        const cb = jest.fn();
        ch._attach(false, null, cb);
        expect(cb.mock.calls).toEqual([[null]]);
    });

    test('T17 leaveChannel while the channel is authorizing: the channel is not attached afterwards', async () => {
        const { auth, client, connector } = makeClient(async () => {
            await wait(50);
            return { token: makeJwt({ 'private:*': ['*'] }) };
        });
        const echoChannel = new AblyPrivateChannel(client, 'private:slow', ECHO_OPTIONS, auth);
        connector.channels['private:slow'] = echoChannel;
        const ch: any = client.channels.get('private:slow');
        echoChannel.unsubscribe(); // what connector.leaveChannel() does
        await wait(150);
        expect(ch.attachCalls).toBe(0);
        expect(ch.state).not.toBe('attached');
    });

    test('T17b leave and re-join while the first authorization is still running: the channel ends up attached', async () => {
        const { auth, client, connector } = makeClient(async () => {
            await wait(50);
            return { token: makeJwt({ 'private:*': ['*'] }) };
        });
        const first = new AblyPrivateChannel(client, 'private:rejoin', ECHO_OPTIONS, auth);
        first.unsubscribe();
        const second = new AblyPrivateChannel(client, 'private:rejoin', ECHO_OPTIONS, auth);
        connector.channels['private:rejoin'] = second;
        const subscribed = jest.fn();
        second.subscribed(subscribed);
        await wait(150);
        const ch: any = client.channels.get('private:rejoin');
        expect(ch.state).toBe('attached');
    });
});
