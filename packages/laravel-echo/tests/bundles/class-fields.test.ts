/**
 * F-048 / E-06: AblyConnector.connect() runs from the base Connector constructor, before the subclass's own field
 * initializers. With ES2022 class fields (define semantics) a plain field declaration would reset what connect()
 * assigned to undefined right after super(). This checks the real ESM bundle, so it needs `pnpm run build` first
 * (bundles project). No network: autoConnect is off and the token function is never called.
 *
 * Runtime checks only: a static check for a bare `ably;` field would also match AblyChannel's, which is safe (its
 * constructor assigns it after super()). Probe (Phase 03): with `useDefineForClassFields: true` and `ably`/`ablyAuth`
 * not `declare`d, both tests fail; with `declare` they pass.
 */
import { describe, expect, test } from "vite-plus/test";
import Echo from "../../dist/echo.js";

const requestTokenFn = async () => ({ token: "never-used" });

describe("class fields in dist/echo.js (F-048)", () => {
    test("the fields connect() assigns survive the subclass constructor", () => {
        const echo = new Echo({ broadcaster: "ably", autoConnect: false, withoutInterceptors: true, requestTokenFn });
        const connector = echo.connector;

        expect(connector.ably).toBeDefined();
        expect(connector.ably.connection.state).toBe("initialized");
        expect(connector.ablyAuth).toBeDefined();
        expect(connector.recoveryListeners).toEqual({
            failed: expect.any(Function),
            connected: expect.any(Function),
            interrupted: expect.any(Function),
        });
        // the initialised fields are set too (after connect(), F-049)
        expect(connector.channels).toEqual({});
        expect(connector.channelsReattachedByAuth).toBe(false);
        echo.disconnect();
    });

    test("connect() called again keeps them", () => {
        const echo = new Echo({ broadcaster: "ably", autoConnect: false, withoutInterceptors: true, requestTokenFn });
        const first = echo.connector.ably;

        echo.connect();

        expect(echo.connector.ably).toBeDefined();
        expect(echo.connector.ably).not.toBe(first);
        expect(echo.connector.ablyAuth).toBeDefined();
        expect(echo.connector.recoveryListeners).not.toBeNull();
        echo.disconnect();
    });
});
