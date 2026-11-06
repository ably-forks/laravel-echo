/**
 * R16: assert the real Ably-Agent header (not device internals or the private httpRequester): it must carry
 * laravel-echo/<version> and the ably-pubsub-device declaration that drives MAU billing. R14: LIB_VERSION guard.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import Echo from '../../src/echo';
import { AblyConnector } from '../../src/connector/ably-connector';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json');

describe('Ably-Agent header', () => {
    let server: http.Server;
    let port: number;
    const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            seen.push({ url: req.url, headers: req.headers });
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify([Date.now()]));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterAll(() => server.close());

    test('options.agents carries laravel-echo, and the wire header carries laravel-echo/<ver> and ably-pubsub-device', async () => {
        const echo = new Echo({
            broadcaster: 'ably',
            endpoint: 'localhost',
            port,
            tls: false,
            autoConnect: false,
            requestTokenFn: async () => ({ token: 'x' }),
        });
        expect(echo.connector.ably.options.agents).toMatchObject({ 'laravel-echo': AblyConnector.LIB_VERSION });
        await echo.connector.ably.time();
        const agent = String(seen[seen.length - 1].headers['ably-agent']);
        expect(agent).toContain(`laravel-echo/${AblyConnector.LIB_VERSION}`);
        expect(agent).toMatch(/(^| )ably-pubsub-device( |$)/);
        echo.disconnect();
    });

    test('R14 guard: LIB_VERSION equals package.json version', () => {
        expect(AblyConnector.LIB_VERSION).toBe(pkg.version);
    });
});
