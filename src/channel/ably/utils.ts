import type { TokenDetails } from '../../../typings/ably';
// Single install: Echo always uses its own copy of @ably/pubsub-device (a dependency). The ESM/CJS builds keep this
// import external, so the app's bundler resolves it; the IIFE build bundles it.
import * as BundledAbly from '@ably/pubsub-device';

/**
 * Invokes a user-supplied callback/listener so that an exception it throws (or a promise it rejects) is reported
 * and never fed back into Echo's own promise chains. ably 1.x behaved the same way: its EventEmitter logged
 * "Unexpected listener exception" and carried on.
 */
export const safeInvoke = (fn: Function | undefined | null, ...args: any[]): void => {
    if (!fn) return;
    const report = (e: any) => console.error('laravel-echo: exception in user callback', e);
    try {
        const result = fn(...args);
        if (result && typeof result.then === 'function') {
            result.then(undefined, report);
        }
    } catch (e) {
        report(e);
    }
};

/**
 * Whether two ably errors describe the same failure: the same object, or the same code and message.
 */
export const isSameError = (a: any, b: any): boolean =>
    !!a && !!b && (a === b || (a.code !== undefined && a.code === b.code && a.message === b.message));

export const isNullOrUndefined = (obj) => obj == null || obj === undefined;
export const isEmptyString = (stringToCheck, ignoreSpaces = true) =>
    (ignoreSpaces ? stringToCheck.trim() : stringToCheck) === '';
export const isNullOrUndefinedOrEmpty = (obj) => obj == null || obj === undefined || isEmptyString(obj);

/**
 * @throws Exception if parsing error
 */
export const parseJwt = (jwtToken: string): { header: any; payload: any } => {
    // Get Token Header
    const base64HeaderUrl = jwtToken.split('.')[0];
    const base64Header = base64HeaderUrl.replace('-', '+').replace('_', '/');
    const header = JSON.parse(fromBase64UrlEncoded(base64Header));
    // Get Token payload
    const base64Url = jwtToken.split('.')[1];
    const base64 = base64Url.replace('-', '+').replace('_', '/');
    const payload = JSON.parse(fromBase64UrlEncoded(base64));
    return { header, payload };
};

// RSA4f - omitted `capability` property
export const toTokenDetails = (jwtToken: string): TokenDetails | any => {
    let payload;
    try {
        payload = parseJwt(jwtToken).payload;
    } catch (e) {
        // a coded error instead of an opaque SyntaxError/TypeError reaching error() listeners / ably's authCallback
        throw httpError('Auth token is not a valid JWT', 500, 50000, e);
    }
    return {
        clientId: payload['x-ably-clientId'],
        expires: payload.exp * 1000, // Convert Seconds to ms
        issued: payload.iat * 1000,
        token: jwtToken,
    };
};

const isBrowser = typeof window === 'object';

/**
 * Helper method to decode base64 url encoded string
 * https://stackoverflow.com/a/78178053
 * @param base64 base64 url encoded string
 * @returns decoded text string
 */
export const fromBase64UrlEncoded = (base64: string): string => {
    const base64Encoded = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const base64WithPadding = base64Encoded + padding;

    if (isBrowser) {
        // P8: atob yields bytes (Latin-1 chars); decode them as UTF-8
        return new TextDecoder().decode(Uint8Array.from(atob(base64WithPadding), (c) => c.charCodeAt(0)));
    }
    return Buffer.from(base64WithPadding, 'base64').toString();
};

/**
 * Helper method to encode text into base64 url encoded string
 * https://stackoverflow.com/a/78178053
 * @param base64 text
 * @returns base64 url encoded string
 */
export const toBase64UrlEncoded = (text: string): string => {
    let encoded = ''
    if (isBrowser) {
        // P8: btoa only accepts Latin-1; encode the UTF-8 bytes instead. Build the binary string in chunks: passing
        // every byte as an argument can exceed the engine's argument limit for large inputs.
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
        }
        encoded = btoa(binary);
    } else {
        encoded = Buffer.from(text).toString('base64');
    }
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const isAbsoluteUrl = (url: string) => (url && url.indexOf('http://') === 0) || url.indexOf('https://') === 0;

export const fullUrl = (url: string) => {
    if (!isAbsoluteUrl(url) && typeof window != 'undefined' && window?.location?.href) {
        // P9: resolve against the page URL, like the browser does (keeps the port, handles paths without a leading /)
        return new URL(url, window.location.href).href;
    }
    return url;
};

/**
 * E3: an Echo-initiated identity switch (a token for another clientId, including null -> user) makes the server
 * reject the in-band AUTH with 40102 while the reconnect is already under way, and the channels then recover by
 * themselves. Within a per-client switch window, the first 40102 per channel is not reported to error() listeners.
 * The window closes on the next `connected`, a `failed` other than 40102, releaseClient() or after 30 s.
 */
const IDENTITY_SWITCH_TIMEOUT_MS = 30_000;
const switchWindows = new WeakMap<object, { suppressed: Set<string>; timer: any }>();

export const beginIdentitySwitch = (client: object) => {
    endIdentitySwitch(client);
    const timer = setTimeout(() => endIdentitySwitch(client), IDENTITY_SWITCH_TIMEOUT_MS);
    timer?.unref?.();
    switchWindows.set(client, { suppressed: new Set(), timer });
};

export const endIdentitySwitch = (client: object) => {
    const w = switchWindows.get(client);
    if (w) {
        clearTimeout(w.timer);
        switchWindows.delete(client);
    }
};

/** true = swallow (the first 40102 per channel inside an Echo-initiated switch window) */
export const consumeSwitchError = (client: object, channelName: string, err: any): boolean => {
    const w = client ? switchWindows.get(client) : undefined;
    const code = err?.code ?? err?.reason?.code;
    if (!w || code !== 40102 || w.suppressed.has(channelName)) return false;
    w.suppressed.add(channelName);
    return true;
};

/**
 * Default timeout for HTTP requests, matching ably-js's default `httpRequestTimeout`.
 */
export const HTTP_REQUEST_TIMEOUT_MS = 10000;

/**
 * The Ably library Echo uses: always its own `@ably/pubsub-device`. A global `Ably` or `AblyPubSub` (the 1.0.x README
 * snippet `window.Ably = Ably`, or the CDN bundle) is never read, so a legacy ably v1/v2 global cannot break Echo.
 */
export const resolveAblyLib = (): any => BundledAbly;

let ignoredGlobalsWarned = false;

/**
 * Logs one `console.warn` per page when a global `Ably` or `AblyPubSub` exists, because Echo ignores it. Only checks
 * whether the globals exist; their values are never used.
 */
export const warnIfAblyGlobalsIgnored = (): void => {
    if (ignoredGlobalsWarned || (typeof Ably === 'undefined' && typeof AblyPubSub === 'undefined')) {
        return;
    }
    ignoredGlobalsWarned = true;
    console.warn(
        '@ably/laravel-echo: the global `Ably` / `AblyPubSub` is ignored; Echo uses its own @ably/pubsub-device. ' +
            'You can remove `window.Ably = ...` (and the Ably CDN script) unless your own code uses it.'
    );
};

/**
 * Builds an error for Echo's auth path (R6). Uses the resolved library's `ErrorInfo` when available, so `instanceof
 * Ably.ErrorInfo` and `toString()` are consistent in every runtime; falls back to a plain `Error`.
 */
export const httpError = (message: string, statusCode: number, code: number, cause?: any): Error => {
    const ErrorInfo = resolveAblyLib()?.ErrorInfo;
    const error: any = typeof ErrorInfo === 'function' ? new ErrorInfo(message, code, statusCode) : new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    if (cause !== undefined) {
        error.cause = cause;
    }
    return error;
};

const deleteHeader = (headers: Record<string, any>, name: string) =>
    Object.keys(headers)
        .filter((key) => key.toLowerCase() === name.toLowerCase())
        .forEach((key) => delete headers[key]);

/**
 * Sends an HTTP request using `fetch` and resolves with the parsed JSON response body, or `null` if the body is empty.
 *
 * Rejects with an error carrying `statusCode` and `code` if:
 * - the request fails at the network level or does not complete within `timeoutMs` (code 50003 for a timeout, 50000 otherwise);
 * - the response status is not 2xx (`code` is always `statusCode * 100`; body codes are never adopted, see R9);
 * - a 2xx response body is not valid JSON (code 50000).
 *
 * Credentials (cookies) are sent cross-origin only when the headers contain the exact lowercase key `authorization`,
 * as ably-js's XHR client (`"authorization" in headers`) did. A capitalised `Authorization` header uses `same-origin`.
 */
export const httpRequestAsync = async (
    options: {
        uri: string;
        method: string;
        headers?: Record<string, any>;
        body?: string;
    },
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS
): Promise<any> => {
    const headers = { ...options.headers };
    deleteHeader(headers, 'Content-Length'); // computed by fetch; any casing (Node fetch rejects/stalls on a wrong value)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
        response = await fetch(options.uri, {
            method: options.method.toUpperCase(),
            headers,
            body: options.body,
            credentials: Object.prototype.hasOwnProperty.call(headers, 'authorization') ? 'include' : 'same-origin',
            signal: controller.signal,
        });
        text = await response.text();
    } catch (err) {
        if (controller.signal.aborted) {
            throw httpError(`Request to ${options.uri} timed out after ${timeoutMs}ms`, 500, 50003, err);
        }
        throw httpError(`Request to ${options.uri} failed: ${err?.message ?? err}`, 500, 50000, err);
    } finally {
        clearTimeout(timer);
    }

    let body: any = null;
    let parseError: any;
    if (text !== '') {
        try {
            body = JSON.parse(text);
        } catch (err) {
            parseError = err;
        }
    }

    if (!response.ok) {
        const errorDetails = body?.error ?? body;
        const m = errorDetails?.message;
        const message = (typeof m === 'string' && m) || text.slice(0, 200) || response.statusText;
        throw httpError(`HTTP ${response.status}: ${message}`, response.status, response.status * 100);
    }
    if (parseError) {
        throw httpError(
            `Expected a JSON response from ${options.uri} (HTTP ${response.status}), got: ${text.slice(0, 100)}`,
            500,
            50000,
            parseError
        );
    }
    return body;
};
