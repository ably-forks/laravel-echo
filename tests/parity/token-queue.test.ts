/**
 * SequentialAuthTokenRequestExecuter / TaskQueue: the promise bridge every channel auth and every connection
 * token renewal (authCallback) goes through.
 */
import { SequentialAuthTokenRequestExecuter } from '../../src/channel/ably/token-request';
import { settle } from './fake-ably';

describe('SequentialAuthTokenRequestExecuter', () => {
    test('runs requests one at a time and passes the previous token to the next request', async () => {
        const seen: any[] = [];
        let active = 0;
        let maxActive = 0;
        const fn = jest.fn(async (channel, token) => {
            active++;
            maxActive = Math.max(maxActive, active);
            seen.push([channel, token]);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return { token: `t-${channel}`, info: { channel } };
        });
        const ex = new SequentialAuthTokenRequestExecuter('t0', fn);
        const results = await Promise.all([ex.request('a'), ex.request('b'), ex.request(null)]);
        expect(maxActive).toBe(1);
        expect(seen).toEqual([
            ['a', 't0'],
            ['b', 't-a'],
            [null, 't-b'],
        ]);
        expect(results.map((r) => r.token)).toEqual(['t-a', 't-b', 't-null']);
    });

    test('requestTokenFn throwing synchronously rejects that request and does not block the queue', async () => {
        const fn = jest
            .fn()
            .mockImplementationOnce(() => {
                throw new Error('sync throw');
            })
            .mockImplementationOnce(async () => ({ token: 't2' }));
        const ex = new SequentialAuthTokenRequestExecuter(null, fn);
        await expect(ex.request('a')).rejects.toThrow('sync throw');
        await expect(ex.request('b')).resolves.toEqual({ token: 't2', info: undefined });
    });

    test('requestTokenFn returning a plain (non-promise) value works', async () => {
        const ex = new SequentialAuthTokenRequestExecuter(null, () => ({ token: 'plain', info: 1 }));
        await expect(ex.request('a')).resolves.toEqual({ token: 'plain', info: 1 });
    });

    test('a rejected request does not block later queued requests', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error('first failed'))
            .mockResolvedValueOnce({ token: 't2' });
        const ex = new SequentialAuthTokenRequestExecuter('t0', fn);
        const p1 = ex.request('a');
        const p2 = ex.request('b');
        await expect(p1).rejects.toThrow('first failed');
        await expect(p2).resolves.toMatchObject({ token: 't2' });
        expect(fn.mock.calls[1]).toEqual(['b', 't0']); // cached token kept after a failure
    });

    // Deferred to Phase 2: fixed by the combined token-path design (review §9.1: T6, T7, T10). Un-skip there.
    test.skip('requestTokenFn resolving without a token string rejects, and does not overwrite the cached token', async () => {
        // T7: a custom requestTokenFn result must be validated before caching; otherwise the executer caches `undefined`
        // and callers later fail in parseJwt with an opaque TypeError.
        const fn = jest.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ token: 't2' });
        const ex = new SequentialAuthTokenRequestExecuter('t0', fn);
        await expect(ex.request('a')).rejects.toThrow(/token/);
        expect(ex.cachedToken).toBe('t0');
    });

    // Deferred to Phase 2: fixed by the combined token-path design (review §9.1: T6, T7, T10). Un-skip there.
    test.skip('a requestTokenFn that never settles does not block every later token request forever', async () => {
        jest.useFakeTimers();
        try {
            const fn = jest
                .fn()
                .mockImplementationOnce(() => new Promise(() => undefined)) // hung custom requestTokenFn
                .mockResolvedValueOnce({ token: 't2' });
            const ex = new SequentialAuthTokenRequestExecuter(null, fn);
            ex.request('a').catch(() => undefined);
            let settled = false;
            ex.request('b').then(
                () => (settled = true),
                () => (settled = true)
            );
            for (let i = 0; i < 5; i++) {
                jest.advanceTimersByTime(60_000);
                for (let j = 0; j < 20; j++) await Promise.resolve();
            }
            expect(settled).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('no unhandled rejection from the internal queue when requests fail', async () => {
        const rejections: any[] = [];
        const h = (r) => rejections.push(r);
        process.on('unhandledRejection', h);
        try {
            const ex = new SequentialAuthTokenRequestExecuter(null, () => Promise.reject(new Error('x')));
            await expect(ex.request('a')).rejects.toThrow('x');
            await settle();
            expect(rejections).toEqual([]);
        } finally {
            process.off('unhandledRejection', h);
        }
    });
});
