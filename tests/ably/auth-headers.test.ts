/**
 * Connector.setOptions must not mutate the caller's auth.headers / userAuthentication.headers (a logout via
 * `bearerToken = null` + `connect()` must not keep the old Authorization). No network: Ably runs on a fake client.
 */
import Echo from '../../src/echo';
import { makeFakeAblyClient } from '../parity/fake-ably';

const make = (broadcaster: string, extra: any = {}) => {
    const opts: any = { broadcaster, ...extra };
    if (broadcaster === 'ably') {
        opts.client = makeFakeAblyClient();
    }
    return opts;
};

describe.each(['ably', 'null'])('auth headers (%s connector)', (broadcaster) => {
    test("the caller's auth.headers and userAuthentication.headers are not mutated", () => {
        const opts = make(broadcaster, { auth: { headers: {} }, userAuthentication: { headers: {} }, bearerToken: 'A' });
        const echo = new Echo(opts);

        expect(opts.auth.headers).toEqual({});
        expect(opts.userAuthentication.headers).toEqual({});
        expect(echo.connector.options.auth.headers.Authorization).toBe('Bearer A');
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBe('Bearer A');
        expect(echo.connector.options.auth.headers).not.toBe(opts.auth.headers);
        expect(echo.connector.options.userAuthentication.headers).not.toBe(opts.userAuthentication.headers);
    });

    test('csrfToken is written into the copy, not the caller object', () => {
        const opts = make(broadcaster, { auth: { headers: {} }, userAuthentication: { headers: {} }, csrfToken: 'tok' });
        const echo = new Echo(opts);

        expect(opts.auth.headers).toEqual({});
        expect(opts.userAuthentication.headers).toEqual({});
        expect(echo.connector.options.auth.headers['X-CSRF-TOKEN']).toBe('tok');
        expect(echo.connector.options.userAuthentication.headers['X-CSRF-TOKEN']).toBe('tok');
    });

    test('logout (bearerToken = null, connect()) leaves no Authorization behind', () => {
        const opts = make(broadcaster, { auth: { headers: {} }, userAuthentication: { headers: {} }, bearerToken: 'A' });
        const echo = new Echo(opts);
        expect(echo.connector.options.auth.headers.Authorization).toBe('Bearer A');

        echo.options.bearerToken = null;
        echo.connect();

        expect(echo.connector.options.auth.headers.Authorization).toBeUndefined();
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBeUndefined();
    });

    test('an explicit caller Authorization header is preserved', () => {
        const opts = make(broadcaster, {
            auth: { headers: { Authorization: 'Basic xyz' } },
            userAuthentication: { headers: { Authorization: 'Basic xyz' } },
        });
        const echo = new Echo(opts);

        expect(echo.connector.options.auth.headers.Authorization).toBe('Basic xyz');
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBe('Basic xyz');
        expect(opts.auth.headers).toEqual({ Authorization: 'Basic xyz' });
    });

    test('with no auth option the per-instance defaults still apply and are not shared', () => {
        const a = new Echo(make(broadcaster, { bearerToken: 'A' }));
        const b = new Echo(make(broadcaster, { bearerToken: 'B' }));

        expect(a.connector.options.auth.headers.Authorization).toBe('Bearer A');
        expect(a.connector.options.userAuthentication.headers.Authorization).toBe('Bearer A');
        expect(b.connector.options.auth.headers.Authorization).toBe('Bearer B');
        expect(a.connector.options.auth.headers).not.toBe(b.connector.options.auth.headers);
    });

    test('userAuthentication.endpoint defaults when userAuthentication is omitted', () => {
        const echo = new Echo(make(broadcaster, { auth: { headers: { 'X-A': '1' } } }));
        expect(echo.connector.options.userAuthentication.endpoint).toBe('/broadcasting/user-auth');
        expect(echo.connector.options.auth.headers['X-A']).toBe('1');
    });

    test('auth given without headers gets the bearer and CSRF headers on the copy', () => {
        const opts = make(broadcaster, { auth: {}, bearerToken: 'A', csrfToken: 'tok' });
        const echo = new Echo(opts);

        expect(echo.connector.options.auth.headers.Authorization).toBe('Bearer A');
        expect(echo.connector.options.auth.headers['X-CSRF-TOKEN']).toBe('tok');
        expect(opts.auth).toEqual({});
    });

    test('userAuthentication given without headers keeps its endpoint and gets headers', () => {
        const echo = new Echo(make(broadcaster, { userAuthentication: { endpoint: '/custom' }, bearerToken: 'A' }));
        expect(echo.connector.options.userAuthentication.endpoint).toBe('/custom');
        expect(echo.connector.options.userAuthentication.headers.Authorization).toBe('Bearer A');
    });
});
