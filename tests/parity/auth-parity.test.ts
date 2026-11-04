/**
 * AblyAuth callback <-> promise bridges: authCallback, tryAuthorizeOnSameConnection, and the patched _attach
 * (beforeChannelAttach) error callback.
 */
import { AblyAuth } from '../../src/channel/ably/auth';
import { makeJwt, settle } from './fake-ably';

/** Stands in for ably's RealtimeChannel class: attach.ts patches `_attach` on its prototype. */
class FakeRealtimeChannel {
    name: string;
    client?: any;
    authorizing?: boolean;
    static internalAttachCalls: any[] = [];
    constructor(name: string) {
        this.name = name;
    }
    _attach(forceReattach, attachReason, errCallback) {
        FakeRealtimeChannel.internalAttachCalls.push([this.name, forceReattach, attachReason]);
        errCallback?.(null);
    }
}

const makeAuth = (requestTokenFn: Function, authorize: jest.Mock = jest.fn((_, opts) => Promise.resolve(opts.token))) => {
    const client: any = {
        channels: { get: (n: string) => Object.assign(new FakeRealtimeChannel(n), { client }) },
        getTimestamp: jest.fn(() => Promise.resolve(Date.now())),
        getTimestampUsingOffset: () => Date.now(),
        auth: { tokenDetails: null, authorize, clientId: 'user1' },
        connection: { on: jest.fn(), off: jest.fn() },
        connect: jest.fn(),
    };
    const connector: any = { ably: client, channels: {} };
    const auth = new AblyAuth(connector, {
        authEndpoint: 'http://localhost/broadcasting/auth',
        auth: { headers: {} },
        requestTokenFn,
    });
    return { auth, client, connector };
};

beforeEach(() => (FakeRealtimeChannel.internalAttachCalls = []));

describe('authCallback (ably-facing, callback style since 1.0.6)', () => {
    test('success: ably callback called once with (null, tokenDetails)', async () => {
        const jwt = makeJwt();
        const { auth } = makeAuth(async () => ({ token: jwt }));
        const cb = jest.fn();
        await (auth.options.authCallback as any)({}, cb);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toBeNull();
        expect(cb.mock.calls[0][1]).toMatchObject({ token: jwt, clientId: 'user1' });
        expect(typeof cb.mock.calls[0][1].expires).toBe('number');
    });

    test('requestTokenFn rejects: ably callback called once with (err, null)', async () => {
        const err = new Error('auth endpoint down');
        const { auth } = makeAuth(() => Promise.reject(err));
        const cb = jest.fn();
        await (auth.options.authCallback as any)({}, cb);
        expect(cb.mock.calls).toEqual([[err, null]]);
    });

    test('malformed token: ably callback called once with an error', async () => {
        const { auth } = makeAuth(async () => ({ token: 'not-a-jwt' }));
        const cb = jest.fn();
        await (auth.options.authCallback as any)({}, cb);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    test('authCallback never rejects (its returned promise is ignored by ably)', async () => {
        const { auth } = makeAuth(() => Promise.reject(new Error('x')));
        await expect((auth.options.authCallback as any)({}, () => undefined)).resolves.toBeUndefined();
    });
    test('if the ably callback throws on success it is not called a second time with that exception', async () => {
        const { auth } = makeAuth(async () => ({ token: makeJwt() }));
        const cb = jest.fn((err) => {
            if (!err) throw new Error('internal');
        });
        await (auth.options.authCallback as any)({}, cb).catch(() => undefined);
        expect(cb).toHaveBeenCalledTimes(1);
    });
});

describe('tryAuthorizeOnSameConnection', () => {
    test('success / failure: callback once', async () => {
        const td = { token: 'x' };
        const ok = makeAuth(async () => ({ token: makeJwt() }), jest.fn(() => Promise.resolve(td)));
        const cb1 = jest.fn();
        ok.auth.tryAuthorizeOnSameConnection({}, cb1);
        const err = new Error('authorize failed');
        const ko = makeAuth(async () => ({ token: makeJwt() }), jest.fn(() => Promise.reject(err)));
        const cb2 = jest.fn();
        ko.auth.tryAuthorizeOnSameConnection({}, cb2);
        await settle();
        expect(cb1.mock.calls).toEqual([[null, td]]);
        expect(cb2.mock.calls).toEqual([[err, null]]);
    });

    test('a callback that throws on success is not re-invoked with that exception', async () => {
        const { auth } = makeAuth(async () => ({ token: makeJwt() }));
        const cb = jest.fn((err) => {
            if (!err) throw new Error('internal attach threw');
        });
        auth.tryAuthorizeOnSameConnection({}, cb);
        await settle();
        expect(cb).toHaveBeenCalledTimes(1);
    });
});

describe('beforeChannelAttach (patched RealtimeChannel._attach)', () => {
    const attachVia = (auth: AblyAuth, name: string) => {
        auth.enableAuthorizeBeforeChannelAttach();
        const ch = Object.assign(new FakeRealtimeChannel(name), { client: auth.ablyClient() });
        const cb = jest.fn();
        ch._attach(false, null, cb);
        return { ch, cb };
    };

    test('public channel: internal attach called immediately with the original callback', async () => {
        const { auth } = makeAuth(jest.fn());
        const { ch, cb } = attachVia(auth, 'public:x');
        expect(FakeRealtimeChannel.internalAttachCalls).toEqual([['public:x', false, null]]);
        expect(cb.mock.calls).toEqual([[null]]);
        expect(ch.authorizing).toBe(false);
    });

    test('private channel success: token requested, authorize called, internal attach called once', async () => {
        const jwt = makeJwt();
        const authorize = jest.fn((_, opts) => Promise.resolve(opts.token));
        const { auth } = makeAuth(async (channel) => ({ token: jwt, info: { channel } }), authorize);
        const { ch, cb } = attachVia(auth, 'private:x');
        await settle();
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(authorize.mock.calls[0][1].token.token).toBe(jwt);
        expect(FakeRealtimeChannel.internalAttachCalls).toEqual([['private:x', false, null]]);
        expect(cb.mock.calls).toEqual([[null]]);
        expect(ch.authorizing).toBe(false);
    });

    test.each([
        ['requestTokenFn rejects', () => Promise.reject(new Error('endpoint 403')), undefined],
        ['requestTokenFn returns a malformed token', async () => ({ token: 'garbage' }), undefined],
        ['authorize rejects', async () => ({ token: makeJwt() }), jest.fn(() => Promise.reject(new Error('40102')))],
    ])('%s: attach callback gets the error once, internal attach not called, authorizing reset', async (_, fn, authorize) => {
        const { auth } = makeAuth(fn as any, authorize as any);
        const { ch, cb } = attachVia(auth, 'private:y');
        await settle();
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(FakeRealtimeChannel.internalAttachCalls).toEqual([]);
        expect(ch.authorizing).toBe(false);
    });

    test('a second _attach while authorizing is not silently dropped (its callback eventually fires)', async () => {
        const { auth } = makeAuth(async () => ({ token: makeJwt() }));
        auth.enableAuthorizeBeforeChannelAttach();
        const ch = Object.assign(new FakeRealtimeChannel('private:z'), { client: auth.ablyClient() });
        const cb1 = jest.fn();
        const cb2 = jest.fn();
        ch._attach(false, null, cb1);
        ch._attach(false, null, cb2); // e.g. channel.subscribe() -> attach() while the first attach is authorizing
        await settle();
        expect(cb1).toHaveBeenCalledTimes(1);
        expect(cb2).toHaveBeenCalledTimes(1);
    });

    test('a synchronous exception while authorizing does not leave the channel stuck in `authorizing`', async () => {
        const { auth, client } = makeAuth(async () => ({ token: makeJwt() }));
        // cached token without x-ably-capability -> parseJwt(...).payload['x-ably-capability'].includes throws TypeError
        const now = Math.floor(Date.now() / 1000);
        const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
        client.auth.tokenDetails = { token: `${b64u({ alg: 'HS256' })}.${b64u({ iat: now, exp: now + 3600 })}.s`, expires: Date.now() + 3600e3 };
        auth.enableAuthorizeBeforeChannelAttach();
        const ch = Object.assign(new FakeRealtimeChannel('private:w'), { client });
        const cb = jest.fn();
        try {
            ch._attach(false, null, cb);
        } catch (e) {
            // v3: thrown inside attach()'s Promise executor -> becomes the attach() rejection
        }
        expect(ch.authorizing).toBe(false);
    });
});
