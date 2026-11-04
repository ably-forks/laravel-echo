/**
 * The combined HTTP/auth/token design (review §9.1) (R1, R6, R9, R12, R18, R20, R21, T6, T7, T10) works as one unit.
 */
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as AblyDevice from '@ably/pubsub-device';
import { AblyAuth } from '../../src/channel/ably/auth';
import { httpError, httpRequestAsync, toTokenDetails } from '../../src/channel/ably/utils';
import { TOKEN_REQUEST_TIMEOUT_MS } from '../../src/channel/ably/token-request';

const jwt = (payload: object) =>
    [{ alg: 'HS256', typ: 'JWT' }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') + '.sig';

const makeAuth = (connectorOptions: any, echoOptions: any = {}) =>
    new AblyAuth({ options: connectorOptions } as any, {
        authEndpoint: 'http://127.0.0.1:1/broadcasting/auth',
        auth: { headers: {} },
        ...echoOptions,
    });

describe('auth token path (review §9.1 combined design)', () => {
    let server: Server;
    let baseUrl: string;
    let handler: (req, res) => void;
    let lastHeaders: any;

    beforeAll(async () => {
        server = createServer((req, res) => {
            lastHeaders = req.headers;
            handler(req, res);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    });
    afterEach(() => {
        delete (globalThis as any).Ably;
    });

    test('R6: httpError is a real v3 ErrorInfo when the global is v3, plain Error otherwise', () => {
        expect(httpError('x', 500, 50000)).not.toBeInstanceOf(AblyDevice.ErrorInfo);
        (globalThis as any).Ably = AblyDevice;
        const e: any = httpError('x', 403, 40300, new Error('c'));
        expect(e).toBeInstanceOf(AblyDevice.ErrorInfo);
        expect(e).toMatchObject({ code: 40300, statusCode: 403, message: 'x' });
        expect(e.cause.message).toBe('c');
    });

    test('R21+T6: queue bound is never shorter than the fetch timeout', () => {
        expect(makeAuth({}).authRequestExecuter.timeoutMs).toBe(TOKEN_REQUEST_TIMEOUT_MS);
        expect(makeAuth({ httpRequestTimeout: 300 }).authRequestExecuter.timeoutMs).toBe(TOKEN_REQUEST_TIMEOUT_MS);
        expect(makeAuth({ httpRequestTimeout: 40000 }).authRequestExecuter.timeoutMs).toBe(41000);
    });

    test('R21: httpRequestTimeout reaches fetch, and the fetch 50003 (with URI) wins over the queue timeout', async () => {
        handler = () => undefined; // never responds
        const auth = makeAuth({ httpRequestTimeout: 300 }, { authEndpoint: `${baseUrl}/auth` });
        const t0 = Date.now();
        const err: any = await auth.authRequestExecuter.request('private:a').catch((e) => e);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(err).toMatchObject({ code: 50003, statusCode: 500 });
        expect(err.message).toContain(`${baseUrl}/auth timed out after 300ms`);
    });

    test('T6: a hung requestTokenFn is bounded, error is coded and names the source', async () => {
        jest.useFakeTimers();
        try {
            const auth = makeAuth({}, { requestTokenFn: () => new Promise(() => undefined) });
            const p = auth.authRequestExecuter.request('private:a').catch((e) => e);
            jest.advanceTimersByTime(TOKEN_REQUEST_TIMEOUT_MS);
            const err: any = await p;
            expect(err).toMatchObject({ code: 50003, statusCode: 500 });
            expect(err.message).toContain('requestTokenFn did not complete');
        } finally {
            jest.useRealTimers();
        }
    });

    test('R12/T7: whitespace token from the authEndpoint path is rejected, cache kept, message names the endpoint', async () => {
        handler = (_, res) => res.end(JSON.stringify({ token: '   ' }));
        const auth = makeAuth({}, { authEndpoint: `${baseUrl}/auth`, token: 'good' });
        const err: any = await auth.authRequestExecuter.request('private:a').catch((e) => e);
        expect(err).toMatchObject({ code: 50000, statusCode: 500 });
        expect(err.message).toBe(`Auth endpoint ${baseUrl}/auth returned a response without a token`);
        expect(auth.authRequestExecuter.cachedToken).toBe('good');
    });

    test('R12/T7: axios-style result from requestTokenFn is rejected and names requestTokenFn', async () => {
        const auth = makeAuth({}, { requestTokenFn: async () => ({ data: { token: 'x' } }), token: 'good' });
        const err: any = await auth.authRequestExecuter.request('private:a').catch((e) => e);
        expect(err.message).toBe('requestTokenFn returned a response without a token');
        expect(auth.authRequestExecuter.cachedToken).toBe('good');
    });

    test('R20: requestToken sends a correct byte Content-Length (none set at source) and the token round-trips', async () => {
        const token = jwt({ 'x-ably-capability': '{"private:ü":["*"]}', exp: 9e9, iat: 1 });
        handler = (req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => res.end(JSON.stringify({ token, info: { body } })));
        };
        const auth = makeAuth({}, { authEndpoint: `${baseUrl}/auth` });
        const res = await auth.authRequestExecuter.request('private:ü');
        expect(res.token).toBe(token);
        expect(Number(lastHeaders['content-length'])).toBe(Buffer.byteLength(JSON.stringify({ channel_name: 'private:ü', token: null })));
    });

    test('R9 option 2 + R18: body codes ignored (40102 on a 500 -> 50000), message falls back to the raw body', async () => {
        handler = (_, res) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: { code: 40102 } }));
        };
        const err: any = await httpRequestAsync({ uri: `${baseUrl}/auth`, method: 'POST', headers: {}, body: '{}' }).catch((e) => e);
        expect(err).toMatchObject({ code: 50000, statusCode: 500 });
        expect(err.message).toBe('HTTP 500: {"error":{"code":40102}}');
    });

    test('non-JWT token gives a coded 50000 error instead of a SyntaxError/TypeError', () => {
        expect(() => toTokenDetails('not-a-jwt')).toThrow(expect.objectContaining({ code: 50000, statusCode: 500 }));
        expect(() => toTokenDetails('')).toThrow(expect.objectContaining({ code: 50000 }));
    });

    test('T10: authCallback calls back exactly once even if the callback throws', async () => {
        const token = jwt({ 'x-ably-capability': '{}', exp: 9e9, iat: 1 });
        const auth = makeAuth({}, { requestTokenFn: async () => ({ token }) });
        const cb = jest.fn(() => {
            throw new Error('ably callback threw');
        });
        await (auth.options.authCallback as any)(null, cb).catch(() => undefined);
        expect(cb).toHaveBeenCalledTimes(1);
    });
});
