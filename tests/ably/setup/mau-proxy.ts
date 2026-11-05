/**
 * MauProxy emulates MAU (monthly active users) enforcement in front of a NORMAL sandbox app: a realtime connection
 * whose token carries a null or '*' clientId is rejected with 40161 ("operation not permitted as it requires an
 * identified client"), as an Ably account with the MAU billing model does. Everything else (REST and the websocket) is
 * forwarded unchanged to the sandbox over https/wss.
 *
 * Echo is pointed at it with `endpoint: 'localhost', port: proxy.port, tls: false, fallbackHosts: [],
 * useBinaryProtocol: false` (JSON protocol only: other formats throw).
 *
 * TODO: replace this mock with a real MAU sandbox app when Ably provides one. Never use a real MAU key.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
// ws ships no types in this repo (@types/ws is not installed), so it is required untyped.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WebSocketServer, WebSocket } = require('ws');

const UPSTREAM = 'sandbox.realtime.ably-nonprod.net'; // host of the nonprod:sandbox endpoint
const MAU_ERROR = { code: 40161, statusCode: 401, message: 'operation not permitted as it requires an identified client' };
const ERROR_ACTION = 9; // ProtocolMessage.ERROR

/** The clientId claim of a JWT: null when absent, null or '*'; undefined when the token is not a JWT. */
export const jwtClientId = (token?: string | null): string | null | undefined => {
    try {
        const claim = JSON.parse(Buffer.from((token as string).split('.')[1], 'base64url').toString())['x-ably-clientId'];
        return claim == null || claim === '*' ? null : claim;
    } catch {
        return undefined;
    }
};

export class MauProxy {
    port = 0;
    /** Number of connections rejected with 40161. */
    rejected = 0;
    private server = http.createServer((req, res) => {
        this.rest(req, res).catch(() => res.destroy());
    });
    private wss = new WebSocketServer({ noServer: true });

    async start(): Promise<this> {
        this.server.on('upgrade', (req, socket, head) => {
            this.wss.handleUpgrade(req, socket, head, (client: any) => this.websocket(client, req));
        });
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        this.port = (this.server.address() as AddressInfo).port;
        return this;
    }

    async stop(): Promise<void> {
        this.wss.clients.forEach((client: any) => client.terminate());
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => this.wss.close(() => resolve()));
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    /** REST (time, ...): forwarded to the sandbox over https. */
    private async rest(req: http.IncomingMessage, res: http.ServerResponse) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const headers: any = { ...req.headers, host: UPSTREAM };
        delete headers['content-length'];
        const upstream = await fetch(`https://${UPSTREAM}${req.url}`, {
            method: req.method,
            headers,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
    }

    private websocket(client: any, req: http.IncomingMessage) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.searchParams.get('format') !== 'json') {
            client.close();
            throw new Error('MauProxy supports the JSON protocol only (set useBinaryProtocol: false)');
        }
        if (jwtClientId(url.searchParams.get('access_token')) === null) {
            this.rejected++;
            client.send(JSON.stringify({ action: ERROR_ACTION, error: MAU_ERROR }));
            client.close();
            return;
        }
        const upstream = new WebSocket(`wss://${UPSTREAM}${req.url}`);
        const queue: { data: any; binary: boolean }[] = [];
        upstream.on('open', () => queue.splice(0).forEach((m) => upstream.send(m.data, { binary: m.binary })));
        upstream.on('message', (data: any, binary: boolean) => client.send(data, { binary }));
        upstream.on('close', () => client.close());
        upstream.on('error', () => client.terminate());
        client.on('message', (data: any, binary: boolean) => {
            if (upstream.readyState === WebSocket.OPEN) {
                upstream.send(data, { binary });
            } else {
                queue.push({ data, binary });
            }
        });
        client.on('close', () => upstream.close());
        client.on('error', () => upstream.terminate());
    }
}
