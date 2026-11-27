/** @jest-environment jsdom */
/**
 * The four request interceptors (Vue, axios, jQuery, Turbo) add X-Socket-Id only once the connection has a key.
 * No network: Echo runs on a fake Ably client; the HTTP libraries are fakes set on globalThis before Echo is created.
 */
import { TextDecoder, TextEncoder } from 'util';
import Echo from '../src/echo';
import { fromBase64UrlEncoded } from '../src/channel/ably/utils';
import { makeFakeAblyClient } from './parity/fake-ably';

const g: any = globalThis;

// jest 27's jsdom environment has no TextEncoder / TextDecoder, which the socket id encoding uses
g.TextEncoder = g.TextEncoder || TextEncoder;
g.TextDecoder = g.TextDecoder || TextDecoder;
const GLOBALS = ['Vue', 'axios', 'jQuery', 'Turbo'];

let vueInterceptors: Function[];
let axiosInterceptor: Function;
let jqueryPrefilter: Function;
let client: any;
let echo: Echo;

// a Turbo listener is added to `document` per Echo; keep them to remove after each test
let turboListeners: any[];
const realAdd = document.addEventListener.bind(document);

beforeEach(() => {
    vueInterceptors = [];
    const vue: any = () => undefined;
    vue.http = { interceptors: vueInterceptors };
    g.Vue = vue;

    const ax: any = () => undefined;
    ax.interceptors = { request: { use: (fn: Function) => (axiosInterceptor = fn) } };
    g.axios = ax;

    const jq: any = () => undefined;
    jq.ajax = () => undefined;
    jq.ajaxPrefilter = (fn: Function) => (jqueryPrefilter = fn);
    g.jQuery = jq;

    g.Turbo = {};

    turboListeners = [];
    jest.spyOn(document, 'addEventListener').mockImplementation(((type: string, l: any, o: any) => {
        turboListeners.push([type, l, o]);
        realAdd(type, l, o);
    }) as any);

    client = makeFakeAblyClient('user1');
    echo = new Echo({ broadcaster: 'ably', client });
});

afterEach(() => {
    turboListeners.forEach(([type, l, o]) => document.removeEventListener(type, l, o));
    jest.restoreAllMocks();
    GLOBALS.forEach((n) => delete g[n]);
});

const vueRequest = () => {
    const set = jest.fn();
    const next = jest.fn();
    vueInterceptors[0]({ headers: { set } }, next);
    expect(next).toHaveBeenCalledTimes(1);
    return set;
};
const axiosHeaders = () => (axiosInterceptor({ headers: {} }) as any).headers;
const jqueryHeaders = () => {
    const setRequestHeader = jest.fn();
    jqueryPrefilter({}, {}, { setRequestHeader });
    return setRequestHeader;
};
const turboHeaders = () => {
    const headers: any = {};
    document.dispatchEvent(new CustomEvent('turbo:before-fetch-request', { detail: { fetchOptions: { headers } } }));
    return headers;
};

test('registers all four interceptors', () => {
    expect(vueInterceptors).toHaveLength(1);
    expect(typeof axiosInterceptor).toBe('function');
    expect(typeof jqueryPrefilter).toBe('function');
    expect(turboListeners.filter(([t]) => t === 'turbo:before-fetch-request')).toHaveLength(1);
});

describe('before the connection has a key', () => {
    test('socketId() is empty', () => {
        expect(echo.socketId()).toBe('');
    });

    test('Vue adds no header', () => {
        expect(vueRequest()).not.toHaveBeenCalled();
    });

    test('axios adds no header', () => {
        expect(axiosHeaders()).toEqual({});
    });

    test('jQuery adds no header', () => {
        expect(jqueryHeaders()).not.toHaveBeenCalled();
    });

    test('Turbo adds no header key', () => {
        const headers = turboHeaders();
        expect(Object.keys(headers)).toEqual([]);
        expect('X-Socket-Id' in headers).toBe(false);
    });
});

describe('once the connection has a key', () => {
    beforeEach(() => {
        client.connection.key = 'k';
    });

    const expectValid = (id: string) => {
        expect(id).toBe(echo.socketId());
        expect(JSON.parse(fromBase64UrlEncoded(id))).toEqual({ connectionKey: 'k', clientId: 'user1' });
    };

    test('Vue adds X-Socket-ID', () => {
        const set = vueRequest();
        expect(set).toHaveBeenCalledTimes(1);
        expect(set.mock.calls[0][0]).toBe('X-Socket-ID');
        expectValid(set.mock.calls[0][1]);
    });

    test('axios adds X-Socket-Id', () => {
        expectValid(axiosHeaders()['X-Socket-Id']);
    });

    test('jQuery adds X-Socket-Id', () => {
        const spy = jqueryHeaders();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe('X-Socket-Id');
        expectValid(spy.mock.calls[0][1]);
    });

    test('Turbo adds X-Socket-Id', () => {
        expectValid(turboHeaders()['X-Socket-Id']);
    });
});
