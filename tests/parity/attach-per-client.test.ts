/**
 * The pre-attach authorize hook is per client (review P2): two Echo clients of one ably build each use their own
 * authorizer, and a client Echo doesn't own attaches through ably's original _attach.
 * Own file: attach.ts patches the RealtimeChannel prototype once per module instance.
 */
import { beforeChannelAttach } from '../../src/channel/ably/attach';

/** RealtimeChannel stand-in: one class per "ably build", channels carry their client like ably's do. */
const makeBuild = () => {
    class FakeRealtimeChannel {
        name: string;
        client: any;
        authorizing?: boolean;
        internalAttachCalls = 0;
        constructor(name: string, client: any) {
            this.name = name;
            this.client = client;
        }
        _attach(_force, _reason, cb) {
            this.internalAttachCalls++;
            cb?.(null);
        }
    }
    const createClient = () => {
        const client: any = {
            channels: {
                all: {} as Record<string, FakeRealtimeChannel>,
                get: (n: string) => (client.channels.all[n] = client.channels.all[n] || new FakeRealtimeChannel(n, client)),
                release: (n: string) => delete client.channels.all[n],
            },
        };
        return client;
    };
    return { FakeRealtimeChannel, createClient };
};

const attach = (client: any, name: string) => {
    const ch = client.channels.get(name);
    const cb = jest.fn();
    ch._attach(false, null, cb);
    return { ch, cb };
};

describe('P2 pre-attach authorize hook per client', () => {
    const build = makeBuild();

    test('two Echo clients of one build each call their own authorizer', () => {
        const echoA = build.createClient();
        const echoB = build.createClient();
        const authorizeA = jest.fn((_c, done) => done(null));
        const authorizeB = jest.fn((_c, done) => done(null));
        beforeChannelAttach(echoA, authorizeA);
        beforeChannelAttach(echoB, authorizeB);
        const a = attach(echoA, 'private:a');
        const b = attach(echoB, 'private:b');
        expect(authorizeA.mock.calls.map(([c]) => c.name)).toEqual(['private:a']);
        expect(authorizeB.mock.calls.map(([c]) => c.name)).toEqual(['private:b']);
        expect([a.ch.internalAttachCalls, b.ch.internalAttachCalls]).toEqual([1, 1]);
        expect(a.cb.mock.calls).toEqual([[null]]);
        expect(b.cb.mock.calls).toEqual([[null]]);
    });

    test('a client Echo does not own attaches through the original _attach, without authorize', () => {
        const echo = build.createClient();
        const authorize = jest.fn((_c, done) => done(null));
        beforeChannelAttach(echo, authorize);
        const other = build.createClient(); // e.g. the app's own createClient() for LiveObjects
        const { ch, cb } = attach(other, 'private:not-echo');
        expect(authorize).not.toHaveBeenCalled();
        expect(ch.internalAttachCalls).toBe(1);
        expect(ch.authorizing).toBeUndefined();
        expect(cb.mock.calls).toEqual([[null]]);
    });

    test('an authorizer error reaches only the attach of its own client', () => {
        const failing = build.createClient();
        const ok = build.createClient();
        const err = new Error('auth endpoint 403');
        beforeChannelAttach(failing, (_c, done) => done(err));
        beforeChannelAttach(ok, (_c, done) => done(null));
        const f = attach(failing, 'private:x');
        const o = attach(ok, 'private:x');
        expect(f.cb.mock.calls).toEqual([[err]]);
        expect(f.ch.internalAttachCalls).toBe(0);
        expect(o.cb.mock.calls).toEqual([[null]]);
    });

    test('the probe channel is released, and an existing channel of that name is left alone', () => {
        const echo = build.createClient();
        beforeChannelAttach(echo, (_c, done) => done(null));
        expect(Object.keys(echo.channels.all)).toEqual([]);
        const withDummy = build.createClient();
        const appChannel = withDummy.channels.get('dummy');
        beforeChannelAttach(withDummy, (_c, done) => done(null));
        expect(withDummy.channels.all.dummy).toBe(appChannel);
    });

    test('the prototype is patched once: repeated installs do not wrap _attach twice', () => {
        const echo = build.createClient();
        const authorize = jest.fn((_c, done) => done(null));
        beforeChannelAttach(echo, authorize);
        beforeChannelAttach(echo, authorize);
        const { ch } = attach(echo, 'private:once');
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(ch.internalAttachCalls).toBe(1);
    });

    test('another ably build (its own RealtimeChannel class) is patched independently', () => {
        const other = makeBuild();
        const echo = other.createClient();
        const authorize = jest.fn((_c, done) => done(null));
        beforeChannelAttach(echo, authorize);
        const { ch } = attach(echo, 'private:other-build');
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(ch.internalAttachCalls).toBe(1);
    });
});
