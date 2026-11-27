import { afterEach, describe, expect, test, vi } from "vite-plus/test";
/**
 * The X-Socket-Id request interceptors (Phase 06, test 16; F-064, F-252): none of them sends a header before the
 * connection has a socket id. The Turbo one had no guard (upstream bug too), so `X-Socket-Id: undefined` reached
 * laravel-broadcaster, whose toOthers() then throws. Runs in the jsdom `unit` project, with the native Ably connector
 * on a fake client (no network).
 */
import Echo from "../../src/echo";
import { fromBase64UrlEncoded } from "../../src/channel/ably/utils";
import { makeFakeAblyClient } from "../parity/fake-ably";

const globals = globalThis as Record<string, any>;

afterEach(() => {
    delete globals.Turbo;
    delete globals.axios;
    delete globals.jQuery;
    delete globals.Vue;
});

const makeEcho = () => {
    const client = makeFakeAblyClient(null);
    const echo = new Echo({ broadcaster: "ably", client });
    const connect = () => {
        client.connection.transition("connecting");
        client.connection.key = "key-1";
        client.connection.transition("connected");
    };
    return { echo, connect };
};

const expectSocketId = (value: unknown) =>
    expect(JSON.parse(fromBase64UrlEncoded(value as string))).toEqual({
        connectionKey: "key-1",
        clientId: null,
    });

describe("X-Socket-Id interceptors before and after the connection is up", () => {
    test("Turbo: no X-Socket-Id before the connection has a key, the socket id after", () => {
        globals.Turbo = {};
        const { connect } = makeEcho();
        const fetchRequest = () => {
            const headers: Record<string, unknown> = {};
            document.dispatchEvent(
                new CustomEvent("turbo:before-fetch-request", {
                    detail: { fetchOptions: { headers } },
                }),
            );
            return headers;
        };

        const before = fetchRequest();
        expect("X-Socket-Id" in before).toBe(false);

        connect();
        expectSocketId(fetchRequest()["X-Socket-Id"]);
    });

    test("axios", () => {
        let interceptor: (config: any) => any = () => undefined;
        globals.axios = Object.assign(() => undefined, {
            interceptors: {
                request: {
                    use: (fn: typeof interceptor) => (interceptor = fn),
                },
            },
        });
        const { connect } = makeEcho();

        expect("X-Socket-Id" in interceptor({ headers: {} }).headers).toBe(
            false,
        );
        connect();
        expectSocketId(interceptor({ headers: {} }).headers["X-Socket-Id"]);
    });

    test("jQuery", () => {
        let prefilter: (...args: any[]) => void = () => undefined;
        globals.jQuery = Object.assign(() => undefined, {
            ajax: () => undefined,
            ajaxPrefilter: (fn: typeof prefilter) => (prefilter = fn),
        });
        const { connect } = makeEcho();
        const xhr = { setRequestHeader: vi.fn() };

        prefilter({}, {}, xhr);
        expect(xhr.setRequestHeader).not.toHaveBeenCalled();
        connect();
        prefilter({}, {}, xhr);
        expect(xhr.setRequestHeader).toHaveBeenCalledTimes(1);
        expect(xhr.setRequestHeader.mock.calls[0][0]).toBe("X-Socket-Id");
        expectSocketId(xhr.setRequestHeader.mock.calls[0][1]);
    });

    test("Vue resource", () => {
        const interceptors: Array<(request: any, next: () => void) => void> =
            [];
        globals.Vue = { http: { interceptors } };
        const { connect } = makeEcho();
        const request = { headers: { set: vi.fn() } };
        const next = vi.fn();

        interceptors[0](request, next);
        expect(request.headers.set).not.toHaveBeenCalled();
        connect();
        interceptors[0](request, next);
        expect(request.headers.set).toHaveBeenCalledTimes(1);
        expect(request.headers.set.mock.calls[0][0]).toBe("X-Socket-ID");
        expectSocketId(request.headers.set.mock.calls[0][1]);
        expect(next).toHaveBeenCalledTimes(2);
    });
});
