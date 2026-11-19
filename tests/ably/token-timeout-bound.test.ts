// Demonstrates the R21 x T6 conflict when applied naively: a fixed queue bound (scaled: 300 ms ~ T's 30 s) shorter
// than httpRequestTimeout (scaled: 400 ms ~ 40 s) pre-empts the fetch timeout; the combined design (max(bound, http+grace)) does not.
import { createServer } from 'http';
import { SequentialAuthTokenRequestExecuter } from '../../src/channel/ably/token-request';
import { httpRequestAsync } from '../../src/channel/ably/utils';
let server; let uri;
beforeAll(async () => { server = createServer(() => undefined); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); uri = `http://127.0.0.1:${server.address().port}/auth`; });
afterAll(() => { server.closeAllConnections(); server.close(); });
const fn = () => httpRequestAsync({ uri, method: 'POST', headers: {}, body: '{}' }, 400);
test('naive fixed bound pre-empts the fetch timeout (generic error, orphaned fetch)', async () => {
    const err: any = await new SequentialAuthTokenRequestExecuter(null, fn, { source: `Auth endpoint ${uri}`, timeoutMs: 300 }).request('private:a').catch((e) => e);
    expect(err.message).toBe(`Auth endpoint ${uri} did not complete within 300ms`);
});
test('combined: bound = max(bound, http+grace) lets the fetch timeout win', async () => {
    const err: any = await new SequentialAuthTokenRequestExecuter(null, fn, { timeoutMs: Math.max(300, 400 + 100) }).request('private:a').catch((e) => e);
    expect(err.message).toBe(`Request to ${uri} timed out after 400ms`);
});
