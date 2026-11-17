/**
 * Patched _attach / AblyAuth.whenConnectedOrSettled: the pre-attach authorize() waits for `connected` while the
 * connection is `initialized` or `connecting` (ably-js aborts and restarts a connecting attempt on authorize(), RTC8b).
 * Own file: attach.ts patches the RealtimeChannel prototype once per module instance.
 */
import { AblyAuth } from '../../src/channel/ably/auth';
import { FakeEmitter, makeJwt } from './fake-ably';

class FakeRealtimeChannel {
    name: string;
    state = 'initialized';
    authorizing?: boolean;
    constructor(name: string) {
        this.name = name;
    }
    attach() {
        return new Promise((resolve, reject) => this._attach(false, null, (e, r) => (e ? reject(e) : resolve(r))));
    }
    _attach(_force, _reason, cb) {
        this.state = 'attached';
        setTimeout(() => cb?.(null), 1);
    }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const makeClient = (state: string) => {
    const channels: Record<string, FakeRealtimeChannel> = {};
    const connection: any = new FakeEmitter();
    connection.state = state;
    connection.set = (next: string, reason?: any) => {
        connection.state = next;
        connection.emit?.(next, { current: next, reason });
    };
    const client: any = {
        channels: { get: (n: string) => (channels[n] = channels[n] || Object.assign(new FakeRealtimeChannel(n), { client })) },
        getTimestamp: jest.fn(() => Promise.resolve(Date.now())),
        getTimestampUsingOffset: () => Date.now(),
        auth: { tokenDetails: null, authorize: jest.fn((_, o) => Promise.resolve(o.token)), clientId: 'user1' },
        connection,
        connect: jest.fn(),
    };
    const connector: any = { ably: client, channels: {} };
    const auth = new AblyAuth(connector, {
        authEndpoint: 'http://localhost/broadcasting/auth',
        auth: { headers: {} },
        requestTokenFn: async () => ({ token: makeJwt({ 'private:p': ['*'] }) }),
    });
    auth.enableAuthorizeBeforeChannelAttach();
    return { client, connection, connector };
};

const listenerCount = (connection: any) =>
    Object.values(connection.events as Record<string, Function[]>).reduce((n, l) => n + l.length, 0) + connection.any.length;

describe('pre-attach authorize waits for `connected`', () => {
    test.each(['initialized', 'connecting'])('%s: authorize() runs only after `connected`; the attach then succeeds', async (state) => {
        const { client, connection } = makeClient(state);
        const base = listenerCount(connection);
        const ch: any = client.channels.get('private:p');
        const attached = ch.attach();
        await tick();
        expect(client.auth.authorize).not.toHaveBeenCalled();
        expect(listenerCount(connection)).toBeGreaterThan(base);
        connection.set('connected');
        await attached;
        expect(client.auth.authorize).toHaveBeenCalledTimes(1);
        expect(listenerCount(connection)).toBe(base);
    });

    test('disconnected is transient: it keeps waiting, and authorize() runs after the next `connected`', async () => {
        const { client, connection } = makeClient('connecting');
        const attached = client.channels.get('private:p').attach();
        await tick();
        connection.set('disconnected');
        await tick();
        expect(client.auth.authorize).not.toHaveBeenCalled();
        connection.set('connecting');
        connection.set('connected');
        await attached;
        expect(client.auth.authorize).toHaveBeenCalledTimes(1);
    });

    test.each(['failed', 'closed', 'closing', 'suspended'])(
        '%s while waiting: the attach is rejected, authorize() is never called, listeners are removed',
        async (state) => {
            const { client, connection } = makeClient('connecting');
            const base = listenerCount(connection);
            const attached = client.channels.get('private:p').attach();
            const reason = Object.assign(new Error(`conn ${state}`), { code: 80000 });
            await tick();
            connection.set(state, reason);
            await expect(attached).rejects.toBe(reason);
            expect(client.auth.authorize).not.toHaveBeenCalled();
            expect(listenerCount(connection)).toBe(base);
            connection.set('connected'); // a later `connected` must not run the abandoned attach
            await tick();
            expect(client.auth.authorize).not.toHaveBeenCalled();
        }
    );

    test('already connected: authorize() runs at once, no connection listener is added', async () => {
        const { client, connection } = makeClient('connected');
        const base = listenerCount(connection);
        await client.channels.get('private:p').attach();
        expect(client.auth.authorize).toHaveBeenCalledTimes(1);
        expect(listenerCount(connection)).toBe(base);
    });

    test('the client was replaced while waiting (no close event): the attach is rejected and the new client is not authorized', async () => {
        const { client, connection, connector } = makeClient('connecting');
        const attached = client.channels.get('private:p').attach();
        await tick();
        const replacement = { auth: { authorize: jest.fn(() => Promise.resolve({})), clientId: 'user1' }, connection: { state: 'connected' } };
        connector.ably = replacement; // Echo.connect() replaced the client; the old one never emitted closed
        connection.set('connected');
        await expect(attached).rejects.toMatchObject({ code: 80000 });
        expect(client.auth.authorize).not.toHaveBeenCalled();
        expect(replacement.auth.authorize).not.toHaveBeenCalled();
    });
});
