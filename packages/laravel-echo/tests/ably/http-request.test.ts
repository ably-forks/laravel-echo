import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { httpRequestAsync } from '../../src/channel/ably/utils';

describe('httpRequestAsync', () => {
    let server: Server;
    let baseUrl: string;
    let handler: (req, res) => void;

    beforeAll(async () => {
        server = createServer((req, res) => handler(req, res));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    });

    const post = (timeoutMs?: number, headers: Record<string, any> = {}) =>
        httpRequestAsync(
            { uri: `${baseUrl}/auth`, method: 'post', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' },
            timeoutMs
        );

    test('resolves with parsed JSON body', async () => {
        handler = (_, res) => res.end(JSON.stringify({ token: 'abc' }));
        await expect(post()).resolves.toEqual({ token: 'abc' });
    });

    test('resolves with null for an empty 2xx body', async () => {
        handler = (_, res) => {
            res.statusCode = 204;
            res.end();
        };
        await expect(post()).resolves.toBeNull();
    });

    test('rejects a non-JSON 2xx body', async () => {
        handler = (_, res) => res.end('<html>login</html>');
        await expect(post()).rejects.toMatchObject({ statusCode: 500, code: 50000 });
    });

    test('ignores an error code in the body of a non-2xx response and derives the code from the status (R9)', async () => {
        handler = (_, res) => {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: { message: 'nope', code: 40160 } }));
        };
        await expect(post()).rejects.toMatchObject({ statusCode: 401, code: 40100, message: 'HTTP 401: nope' });
    });

    test('rejects a non-2xx response without an Ably error, deriving the code from the status', async () => {
        handler = (_, res) => {
            res.statusCode = 403;
            res.end('Forbidden page');
        };
        await expect(post()).rejects.toMatchObject({ statusCode: 403, code: 40300, message: 'HTTP 403: Forbidden page' });
    });

    test('rejects a Laravel-style {"message"} error body with the message and a status-derived code', async () => {
        handler = (_, res) => {
            res.statusCode = 403;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ message: 'This action is unauthorized.' }));
        };
        await expect(post()).rejects.toMatchObject({
            statusCode: 403,
            code: 40300,
            message: 'HTTP 403: This action is unauthorized.',
        });
    });

    test('rejects with a timeout error when the server does not respond', async () => {
        handler = () => undefined; // never responds
        await expect(post(100)).rejects.toMatchObject({ statusCode: 500, code: 50003 });
    });

    test('rejects with a coded error on network failure', async () => {
        await expect(
            httpRequestAsync({ uri: 'http://127.0.0.1:1/auth', method: 'post', headers: {}, body: '{}' })
        ).rejects.toMatchObject({ statusCode: 500, code: 50000 });
    });

    describe('credentials', () => {
        const realFetch = global.fetch;
        let fetchMock: jest.Mock;

        beforeEach(() => {
            fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
            global.fetch = fetchMock;
        });

        afterEach(() => {
            global.fetch = realFetch;
        });

        test('includes credentials when an Authorization header is set', async () => {
            await post(undefined, { authorization: 'Bearer x' });
            expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
        });

        test('uses same-origin credentials for a capitalised Authorization header (XHR parity)', async () => {
            await post(undefined, { Authorization: 'Bearer x' });
            expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
        });

        test('drops content-length in any case', async () => {
            await post(undefined, { 'content-length': 999, 'CONTENT-LENGTH': 1 });
            expect(Object.keys(fetchMock.mock.calls[0][1].headers).map((k) => k.toLowerCase())).not.toContain('content-length');
        });

        test('uses same-origin credentials otherwise, and drops Content-Length', async () => {
            await post(undefined, { 'Content-Length': 2 });
            const init = fetchMock.mock.calls[0][1];
            expect(init.credentials).toBe('same-origin');
            expect(init.headers).not.toHaveProperty('Content-Length');
        });
    });
});
