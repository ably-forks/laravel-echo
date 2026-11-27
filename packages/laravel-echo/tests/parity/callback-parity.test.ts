/**
 * Callback-style parity for Echo's public API now that ably calls are promise based.
 *
 * Contract (as in @ably/laravel-echo 1.0.6 + ably 1.x, where ably invoked the user callback once):
 *   - a user callback is invoked EXACTLY ONCE per operation, with `null` on success or the ably error on failure;
 *   - an exception thrown by (or a rejection returned by) a user callback is never fed back into the same callback
 *     as if it were an ably error, and never surfaces as an unhandled promise rejection.
 */
import { AblyPresenceChannel, AblyPrivateChannel } from '../../src/channel';
import {
    ECHO_OPTIONS,
    ablyError,
    makeFakeAbly,
    settle,
    stubAuth,
    trackUnhandledRejections,
} from './fake-ably';

type Op = {
    name: string;
    make: () => { echoChannel: any; fake: any };
    call: (echoChannel: any, cb?: Function) => any;
    fakeFn: (fake: any) => jest.Mock;
};

const presence = () => {
    const ably = makeFakeAbly();
    const echoChannel = new AblyPresenceChannel(ably, 'presence:room', ECHO_OPTIONS, stubAuth);
    return { echoChannel, fake: ably.channels.get('presence:room') };
};
const priv = () => {
    const ably = makeFakeAbly();
    const echoChannel = new AblyPrivateChannel(ably, 'private:room', ECHO_OPTIONS, stubAuth);
    return { echoChannel, fake: ably.channels.get('private:room') };
};

const OPS: Op[] = [
    { name: 'private whisper', make: priv, call: (c, cb) => c.whisper('typing', { a: 1 }, cb), fakeFn: (f) => f.publish },
    { name: 'presence whisper', make: presence, call: (c, cb) => c.whisper('typing', { a: 1 }, cb), fakeFn: (f) => f.publish },
    { name: 'presence enter', make: presence, call: (c, cb) => c.enter({ a: 1 }, cb), fakeFn: (f) => f.presence.enter },
    { name: 'presence update', make: presence, call: (c, cb) => c.update({ a: 1 }, cb), fakeFn: (f) => f.presence.update },
    { name: 'presence leave', make: presence, call: (c, cb) => c.leave({ a: 1 }, cb), fakeFn: (f) => f.presence.leave },
];

let unhandled: ReturnType<typeof trackUnhandledRejections>;
beforeEach(() => (unhandled = trackUnhandledRejections()));
afterEach(() => unhandled.stop());

describe.each(OPS)('$name callback parity', (op) => {
    test('success: callback called once with null', async () => {
        const { echoChannel } = op.make();
        const cb = jest.fn();
        op.call(echoChannel, cb);
        await settle();
        expect(cb.mock.calls).toEqual([[null]]);
    });

    test('failure: callback called once with the ably error', async () => {
        const { echoChannel, fake } = op.make();
        const err = ablyError();
        op.fakeFn(fake).mockImplementationOnce(() => Promise.reject(err));
        const cb = jest.fn();
        op.call(echoChannel, cb);
        await settle();
        expect(cb.mock.calls).toEqual([[err]]);
    });

    test('callback is invoked asynchronously (after the method returns), never synchronously', async () => {
        const { echoChannel } = op.make();
        let returned = false;
        let calledBeforeReturn: boolean | undefined;
        op.call(echoChannel, () => (calledBeforeReturn = !returned));
        returned = true;
        await settle();
        expect(calledBeforeReturn).toBe(false);
    });

    test('method returns the channel for chaining', () => {
        const { echoChannel } = op.make();
        expect(op.call(echoChannel, () => undefined)).toBe(echoChannel);
    });

    // ---- regression guards for T1–T3: .then(() => cb(null)).catch(err => cb(err)) re-invoked callbacks ----

    test('success + callback throws: callback NOT re-invoked with its own exception', async () => {
        const { echoChannel } = op.make();
        const cb = jest.fn(() => {
            throw new Error('user bug');
        });
        op.call(echoChannel, cb);
        await settle();
        expect(cb.mock.calls).toEqual([[null]]);
    });

    test('success + callback always throws: no unhandled promise rejection', async () => {
        const { echoChannel } = op.make();
        op.call(echoChannel, () => {
            throw new Error('user bug');
        });
        await settle();
        expect(unhandled.rejections).toEqual([]);
    });

    test('failure + callback throws: no unhandled promise rejection', async () => {
        const { echoChannel, fake } = op.make();
        op.fakeFn(fake).mockImplementationOnce(() => Promise.reject(ablyError()));
        op.call(echoChannel, () => {
            throw new Error('user bug in error handler');
        });
        await settle();
        expect(unhandled.rejections).toEqual([]);
    });

    test('async callback that rejects is invoked once (its rejection is not treated as an ably error)', async () => {
        const { echoChannel } = op.make();
        const calls: any[] = [];
        op.call(echoChannel, async (err) => {
            calls.push(err);
            throw new Error('async user bug');
        });
        await settle();
        expect(calls).toEqual([null]);
    });
});

describe('no callback: ably failure is routed to error() listeners (since the ably v2 migration; 1.0.6 dropped it)', () => {
    test.each(OPS)('$name', async (op) => {
        const { echoChannel, fake } = op.make();
        const err = ablyError();
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        op.fakeFn(fake).mockImplementationOnce(() => Promise.reject(err));
        op.call(echoChannel, undefined);
        await settle();
        expect(errorListener).toHaveBeenCalledWith(err);
        expect(unhandled.rejections).toEqual([]);
    });
});

describe('here() parity', () => {
    const setup = () => {
        const { echoChannel, fake } = presence();
        return { echoChannel, fake, emitEnter: () => fake.presence.emitter.emit('enter', { data: { id: 2 }, clientId: 'u2' }) };
    };

    test('member-list change: callback(members data, null) once', async () => {
        const { echoChannel, fake, emitEnter } = setup();
        fake.presence.get.mockResolvedValue([{ data: { id: 1 } }, { data: { id: 2 } }]);
        const cb = jest.fn();
        echoChannel.here(cb);
        emitEnter();
        await settle();
        expect(cb.mock.calls).toEqual([[[{ id: 1 }, { id: 2 }], null]]);
    });

    test('presence.get failure: callback([], err) once (1.0.6 threw TypeError here; the ably v2 migration fixed it)', async () => {
        const { echoChannel, fake, emitEnter } = setup();
        const err = ablyError('get failed', 91000);
        fake.presence.get.mockRejectedValue(err);
        const cb = jest.fn();
        echoChannel.here(cb);
        emitEnter();
        await settle();
        expect(cb.mock.calls).toEqual([[[], err]]);
    });

    test('callback throws on success: NOT re-invoked with ([], its own exception)', async () => {
        const { echoChannel, fake, emitEnter } = setup();
        fake.presence.get.mockResolvedValue([{ data: { id: 1 } }]);
        const cb = jest.fn(() => {
            throw new Error('user bug');
        });
        echoChannel.here(cb);
        emitEnter();
        await settle();
        expect(cb.mock.calls).toEqual([[[{ id: 1 }], null]]);
    });

    test('callback always throws: no unhandled promise rejection', async () => {
        const { echoChannel, fake, emitEnter } = setup();
        fake.presence.get.mockResolvedValue([{ data: { id: 1 } }]);
        echoChannel.here(() => {
            throw new Error('user bug');
        });
        emitEnter();
        await settle();
        expect(unhandled.rejections).toEqual([]);
    });
});

describe('joining()/leaving()/listen() callbacks', () => {
    test('joining/leaving pass (data, metadata without data); a throwing callback does not stop other ably listeners', async () => {
        const { echoChannel, fake } = presence();
        const joined = jest.fn(() => {
            throw new Error('user bug');
        });
        const left = jest.fn();
        const other = jest.fn();
        echoChannel.joining(joined).leaving(left);
        fake.presence.emitter.on('enter', other);
        fake.presence.emitter.emit('enter', { data: { id: 2 }, clientId: 'u2' });
        fake.presence.emitter.emit('leave', { data: { id: 2 }, clientId: 'u2' });
        await settle();
        expect(joined).toHaveBeenCalledWith({ id: 2 }, { clientId: 'u2' });
        expect(left).toHaveBeenCalledWith({ id: 2 }, { clientId: 'u2' });
        expect(other).toHaveBeenCalled();
        expect(unhandled.rejections).toEqual([]);
    });

    test('listen() callback gets (data, metadata) and stopListening(event, cb) removes exactly that wrapper', async () => {
        const { echoChannel, fake } = priv();
        const cb = jest.fn();
        echoChannel.listen('Foo', cb);
        fake.messages.emit('App\\Events\\Foo', { name: 'App\\Events\\Foo', data: 'x', id: 'm1' });
        echoChannel.stopListening('Foo', cb);
        fake.messages.emit('App\\Events\\Foo', { name: 'App\\Events\\Foo', data: 'y', id: 'm2' });
        expect(cb.mock.calls).toEqual([['x', { name: 'App\\Events\\Foo', id: 'm1' }]]);
    });
});

describe('presence channel lifecycle', () => {
    test('auto-enter on attached uses presenceData; enter failure goes to error() listeners once', async () => {
        const { echoChannel, fake } = presence();
        echoChannel.presenceData = { id: 1 };
        const err = ablyError('enter refused');
        fake.presence.enter.mockImplementationOnce(() => Promise.reject(err));
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        fake.transition('attached');
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledWith({ id: 1 });
        expect(errorListener.mock.calls).toEqual([[err]]);
    });

    test('unsubscribe(): leave + detach rejections are handled (no unhandled rejection, error listeners already cleared)', async () => {
        const { echoChannel, fake } = presence();
        fake.presence.leave.mockRejectedValue(ablyError('leave failed'));
        fake.detach.mockRejectedValue(ablyError('detach failed'));
        const errorListener = jest.fn();
        echoChannel.error(errorListener);
        echoChannel.unsubscribe();
        await settle();
        expect(fake.presence.leave).toHaveBeenCalled();
        expect(fake.detach).toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled(); // same as 1.0.6: listeners are unregistered synchronously
        expect(unhandled.rejections).toEqual([]);
    });

    test('every ably promise rejecting at once never leaks an unhandled rejection when user callbacks behave', async () => {
        const { echoChannel, fake } = presence();
        const reject = () => Promise.reject(ablyError());
        [fake.attach, fake.detach, fake.publish, fake.presence.enter, fake.presence.leave, fake.presence.update, fake.presence.get].forEach(
            (m) => m.mockImplementation(reject)
        );
        echoChannel.error(() => undefined);
        (echoChannel as any)
            .listen('A', () => undefined)
            .listenToAll(() => undefined)
            .here(() => undefined)
            .joining(() => undefined)
            .leaving(() => undefined)
            .whisper('w', {})
            .enter({})
            .update({})
            .leave({});
        fake.presence.emitter.emit('enter', { data: {} });
        fake.transition('attached');
        echoChannel.subscribe();
        echoChannel.unsubscribe();
        await settle();
        expect(unhandled.rejections).toEqual([]);
    });
});
