import { vi, describe, test, expect } from "vite-plus/test";
/**
 * Patched _attach / AblyAuth.whenConnectedOrSettled: the pre-attach authorize() waits for `connected` while the
 * connection is `initialized`, `connecting` or `disconnected` (authorize() restarts a connecting attempt, RTC8b, and
 * triggers an early reconnect from disconnected), and is abandoned, authorize() never called, on failed or suspended.
 * Own file: attach.ts patches the RealtimeChannel prototype once per module instance.
 */
import { AblyAuth } from "../../src/channel/ably/auth";
import type { AblyOptions } from "../../src/connector/ably-connector";
import { FakeEmitter, makeJwt } from "./fake-ably";

class FakeRealtimeChannel {
    name: string;
    state = "initialized";
    authorizing?: boolean;
    constructor(name: string) {
        this.name = name;
    }
    attach() {
        return new Promise((resolve, reject) =>
            this._attach(false, null, (e?: unknown, r?: unknown) =>
                e ? reject(e) : resolve(r),
            ),
        );
    }
    _attach(_force?: boolean, _reason?: unknown, cb?: (err?: unknown) => void) {
        this.state = "attached";
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
        channels: {
            get: (n: string) =>
                (channels[n] =
                    channels[n] ||
                    Object.assign(new FakeRealtimeChannel(n), { client })),
        },
        getTimestamp: vi.fn(() => Promise.resolve(Date.now())),
        getTimestampUsingOffset: () => Date.now(),
        auth: {
            tokenDetails: null,
            authorize: vi.fn((_, o) => Promise.resolve(o.token)),
            clientId: "user1",
        },
        connection,
        connect: vi.fn(),
    };
    const connector: any = { ably: client, channels: {} };
    const auth = new AblyAuth(connector, {
        authEndpoint: "http://localhost/broadcasting/auth",
        auth: { headers: {} },
        requestTokenFn: async () => ({
            token: makeJwt({ "private:p": ["*"] }),
        }),
    } as unknown as AblyOptions); // partial options: the AblyAuth paths under test read only these
    auth.enableAuthorizeBeforeChannelAttach();
    return { client, connection, connector };
};

const listenerCount = (connection: any) =>
    Object.values(connection.events as Record<string, Function[]>).reduce(
        (n, l) => n + l.length,
        0,
    ) + connection.any.length;

const spyOnOff = (connection: any) => {
    const on = vi.spyOn(connection, "on");
    const off = vi.spyOn(connection, "off");
    return { on, off };
};

describe("pre-attach authorize waits for `connected`", () => {
    test.each(["initialized", "connecting"])(
        "%s: authorize() runs only after `connected`; the attach then succeeds",
        async (state) => {
            const { client, connection } = makeClient(state);
            const base = listenerCount(connection);
            const ch: any = client.channels.get("private:p");
            const attached = ch.attach();
            await tick();
            expect(client.auth.authorize).not.toHaveBeenCalled();
            expect(listenerCount(connection)).toBeGreaterThan(base);
            connection.set("connected");
            await attached;
            expect(client.auth.authorize).toHaveBeenCalledTimes(1);
            expect(listenerCount(connection)).toBe(base);
        },
    );

    test.each(["initialized", "connecting", "disconnected"])(
        "a token arriving while %s waits for connected; authorize() is not called before, one listener, removed after",
        async (state) => {
            const { client, connection } = makeClient(state);
            const { on, off } = spyOnOff(connection);
            const base = listenerCount(connection);
            const attached = client.channels.get("private:p").attach();
            await tick(60);
            expect(client.auth.authorize).not.toHaveBeenCalled();
            expect(on).toHaveBeenCalledTimes(1);
            expect(on.mock.calls[0]).toHaveLength(1); // a single all-events listener
            expect(listenerCount(connection)).toBe(base + 1);
            connection.set("connected");
            await attached;
            expect(client.auth.authorize).toHaveBeenCalledTimes(1);
            expect(off).toHaveBeenCalledTimes(1);
            expect(off.mock.calls[0][0]).toBe(on.mock.calls[0][0]);
            expect(listenerCount(connection)).toBe(base);
        },
    );

    test.each(["failed", "suspended"])(
        "entry in %s: abandoned with the connection error, authorize() never called",
        async (state) => {
            const { client, connection } = makeClient(state);
            const reason = Object.assign(new Error(`conn ${state}`), {
                code: 80002,
            });
            connection.errorReason = reason;
            const { on } = spyOnOff(connection);
            await expect(
                client.channels.get("private:p").attach(),
            ).rejects.toBe(reason);
            expect(client.auth.authorize).not.toHaveBeenCalled();
            expect(on).not.toHaveBeenCalled();
            expect(listenerCount(connection)).toBe(0);
        },
    );

    test("entry in failed without an errorReason: rejected with code 80000", async () => {
        const { client } = makeClient("failed");
        await expect(
            client.channels.get("private:p").attach(),
        ).rejects.toMatchObject({ code: 80000 });
        expect(client.auth.authorize).not.toHaveBeenCalled();
    });

    test("disconnected, then suspended while waiting: abandoned", async () => {
        const { client, connection } = makeClient("disconnected");
        const attached = client.channels.get("private:p").attach();
        await tick();
        const reason = Object.assign(new Error("suspended"), { code: 80002 });
        connection.set("suspended", reason);
        await expect(attached).rejects.toBe(reason);
        expect(client.auth.authorize).not.toHaveBeenCalled();
        expect(listenerCount(connection)).toBe(0);
    });

    test("disconnected is transient: it keeps waiting, and authorize() runs after the next `connected`", async () => {
        const { client, connection } = makeClient("connecting");
        const attached = client.channels.get("private:p").attach();
        await tick();
        connection.set("disconnected");
        await tick();
        expect(client.auth.authorize).not.toHaveBeenCalled();
        connection.set("connecting");
        connection.set("connected");
        await attached;
        expect(client.auth.authorize).toHaveBeenCalledTimes(1);
    });

    test.each(["failed", "closed", "closing", "suspended"])(
        "%s while waiting: the attach is rejected, authorize() is never called, listeners are removed",
        async (state) => {
            const { client, connection } = makeClient("connecting");
            const base = listenerCount(connection);
            const attached = client.channels.get("private:p").attach();
            const reason = Object.assign(new Error(`conn ${state}`), {
                code: 80000,
            });
            await tick();
            connection.set(state, reason);
            await expect(attached).rejects.toBe(reason);
            expect(client.auth.authorize).not.toHaveBeenCalled();
            expect(listenerCount(connection)).toBe(base);
            connection.set("connected"); // a later `connected` must not run the abandoned attach
            await tick();
            expect(client.auth.authorize).not.toHaveBeenCalled();
        },
    );

    test("already connected: authorize() runs at once, no connection listener is added", async () => {
        const { client, connection } = makeClient("connected");
        const base = listenerCount(connection);
        await client.channels.get("private:p").attach();
        expect(client.auth.authorize).toHaveBeenCalledTimes(1);
        expect(listenerCount(connection)).toBe(base);
    });

    test("the client was replaced while waiting (no close event): the attach is rejected and the new client is not authorized", async () => {
        const { client, connection, connector } = makeClient("connecting");
        const attached = client.channels.get("private:p").attach();
        await tick();
        const replacement = {
            auth: {
                authorize: vi.fn(() => Promise.resolve({})),
                clientId: "user1",
            },
            connection: { state: "connected" },
        };
        connector.ably = replacement; // Echo.connect() replaced the client; the old one never emitted closed
        connection.set("connected");
        await expect(attached).rejects.toMatchObject({ code: 80000 });
        expect(client.auth.authorize).not.toHaveBeenCalled();
        expect(replacement.auth.authorize).not.toHaveBeenCalled();
    });

    test("proceed throws synchronously after `connected`: the error reaches the attach error callback once, the listener is removed", async () => {
        const { client, connection } = makeClient("connecting");
        const base = listenerCount(connection);
        const boom = new Error("proceed threw");
        // authOptionsForToken reads auth.clientId inside the deferred proceed; make that step throw once connected
        Object.defineProperty(client.auth, "clientId", {
            get: () => {
                if (connection.state === "connected") throw boom;
                return "user1";
            },
        });
        const attached = client.channels.get("private:p").attach();
        attached.catch(() => void 0);
        await tick();
        expect(listenerCount(connection)).toBe(base + 1);
        connection.set("connected");
        await expect(attached).rejects.toBe(boom); // the attach callback was called with the error, exactly once
        expect(client.auth.authorize).not.toHaveBeenCalled();
        expect(listenerCount(connection)).toBe(base);
        expect(connection.listenerErrors).toHaveLength(0); // not swallowed by the emitter
    });
});
