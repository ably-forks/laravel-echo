/**
 * A minimal fake of the ably RealtimeChannel / RealtimePresence surface that Echo uses (the same in ably 2.30
 * and @ably/pubsub-device 3.0.0, so these tests run unchanged on master and on the pubsub-device branch).
 *
 * It models the parts of v3 behaviour that matter for callback <-> promise parity:
 * - every operation returns a Promise (publish, attach, detach, subscribe, presence.enter/leave/update/get/subscribe);
 * - `subscribe()` / `presence.subscribe()` implicitly call `attach()` and reject when it rejects
 *   (v3 dist node.js `_subscribeImpl` ~L5387-5398 and presence ~L5970, `attachOnSubscribe` defaults to true);
 * - the EventEmitter catches and logs listener exceptions per listener (pubsub-core `callListener`, build/index.js:178-183),
 *   so one throwing ably listener never stops other ably listeners.
 */

export class FakeEmitter {
    any: Function[] = [];
    events: Record<string, Function[]> = {};
    listenerErrors: any[] = [];

    on(...args: any[]) {
        if (args.length === 1) {
            this.any.push(args[0]);
            return;
        }
        const [event, listener] = args;
        const names = Array.isArray(event) ? event : [event];
        names.forEach((n) => (this.events[n] = this.events[n] || []).push(listener));
    }

    once(event: string, listener: Function) {
        const wrapper = (...a) => {
            this.off(event, wrapper);
            listener(...a);
        };
        this.on(event, wrapper);
    }

    off(...args: any[]) {
        if (args.length === 0) {
            this.any = [];
            this.events = {};
            return;
        }
        if (args.length === 1 && typeof args[0] === 'function') {
            this.any = this.any.filter((l) => l !== args[0]);
            Object.keys(this.events).forEach((k) => (this.events[k] = this.events[k].filter((l) => l !== args[0])));
            return;
        }
        const [event, listener] = args;
        if (!listener) delete this.events[event];
        else this.events[event] = (this.events[event] || []).filter((l) => l !== listener);
    }

    emit(event: string, ...args: any[]) {
        const listeners = [...this.any, ...(this.events[event] || [])];
        listeners.forEach((l) => {
            try {
                l(...args);
            } catch (e) {
                // like ably's onListenerError: log and continue
                this.listenerErrors.push(e);
            }
        });
    }
}

export const makeFakeChannel = (name: string) => {
    const stateEmitter = new FakeEmitter();
    const messages = new FakeEmitter();
    const presenceEmitter = new FakeEmitter();
    const channel: any = {
        name,
        state: 'initialized',
        stateEmitter,
        messages,
        on: (...a) => stateEmitter.on(...a),
        once: (...a) => (stateEmitter as any).once(...a),
        off: (...a) => stateEmitter.off(...a),
        attach: jest.fn(() => Promise.resolve(null)),
        detach: jest.fn(() => Promise.resolve()),
        publish: jest.fn(() => Promise.resolve()),
        unsubscribe: jest.fn((...a) => messages.off(...a)),
        subscribe: jest.fn((...args: any[]) => {
            if (args.length === 1) messages.on(args[0]);
            else messages.on(args[0], args[1]);
            return channel.attach(); // attachOnSubscribe (default true)
        }),
        presence: {
            emitter: presenceEmitter,
            enter: jest.fn(() => Promise.resolve()),
            leave: jest.fn(() => Promise.resolve()),
            update: jest.fn(() => Promise.resolve()),
            get: jest.fn(() => Promise.resolve([])),
            unsubscribe: jest.fn(),
            subscribe: jest.fn((...args: any[]) => {
                if (args.length === 1) presenceEmitter.on(args[0]);
                else presenceEmitter.on(args[0], args[1]);
                return channel.attach();
            }),
        },
        /** Simulate a channel state change as ably emits it. */
        transition(current: string, reason?: any) {
            const previous = channel.state;
            channel.state = current;
            stateEmitter.emit(current, { previous, current, reason, resumed: false });
        },
    };
    return channel;
};

export const makeFakeAbly = () => {
    const channels: Record<string, any> = {};
    return {
        channels: {
            get: (name: string) => (channels[name] = channels[name] || makeFakeChannel(name)),
            all: channels,
        },
    };
};

/** A stub AblyAuth with just what private/presence channel constructors use. */
export const stubAuth: any = { onChannelFailed: () => () => undefined };

export const ECHO_OPTIONS = { namespace: 'App.Events' };

/** Collects unhandled promise rejections raised while a test runs. */
export const trackUnhandledRejections = () => {
    const rejections: any[] = [];
    const handler = (reason: any) => rejections.push(reason);
    process.on('unhandledRejection', handler);
    return { rejections, stop: () => process.off('unhandledRejection', handler) };
};

/** Let pending promise chains settle and Node emit `unhandledRejection` for them. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

export const ablyError = (message = 'ably failure', code = 40160) => {
    const e: any = new Error(message);
    e.code = code;
    e.statusCode = 401;
    return e;
};

const b64u = (o: any) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const makeJwt = (capability: Record<string, string[]> = { 'private:*': ['*'] }, clientId = 'user1') => {
    const now = Math.floor(Date.now() / 1000);
    return (
        b64u({ alg: 'HS256', typ: 'JWT', kid: 'a.b' }) +
        '.' +
        b64u({ iat: now, exp: now + 3600, 'x-ably-clientId': clientId, 'x-ably-capability': JSON.stringify(capability) }) +
        '.sig'
    );
};

/**
 * A fake ably client that also has a connection emitter (with `connect`) and an `auth` (clientId, authorize), for
 * the identity-switch tests. `makeFakeAbly` itself is unchanged.
 */
export const makeFakeAblyClient = (clientId?: string | null) => {
    const connection: any = new FakeEmitter();
    const client: any = makeFakeAbly();
    client.connect = jest.fn(); // Echo's onClientIdChanged calls client.connect()
    client.connection = connection;
    client.auth = {
        clientId,
        authorize: jest.fn(() => Promise.resolve({})) as jest.Mock<Promise<any>, any[]>,
    };
    return client;
};
