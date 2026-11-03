import type { TokenDetails } from '../../../typings/ably';

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
    const { payload } = parseJwt(jwtToken);
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
        return atob(base64WithPadding);
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
        encoded = btoa(text);
    } else {
        encoded = Buffer.from(text).toString('base64');
    }
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const isAbsoluteUrl = (url: string) => (url && url.indexOf('http://') === 0) || url.indexOf('https://') === 0;

export const fullUrl = (url: string) => {
    if (!isAbsoluteUrl(url) && typeof window != 'undefined') {
        const host = window?.location?.hostname;
        const port = window?.location?.port;
        const protocol = window?.location?.protocol.replace(':', '');
        if (host && port && protocol) {
            return protocol + '://' + host + ':' + port + url;
        }
    }
    return url;
};

/**
 * Default timeout for HTTP requests, matching ably-js's default `httpRequestTimeout`.
 */
export const HTTP_REQUEST_TIMEOUT_MS = 10000;

const httpError = (message: string, statusCode: number, code: number, cause?: any): Error => {
    const error: any = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    if (cause !== undefined) {
        error.cause = cause;
    }
    return error;
};

const hasHeader = (headers: Record<string, any>, name: string) =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

/**
 * Sends an HTTP request using `fetch` and resolves with the parsed JSON response body, or `null` if the body is empty.
 *
 * Rejects with an error carrying `statusCode` and `code` if:
 * - the request fails at the network level or does not complete within `timeoutMs` (code 50003 for a timeout, 50000 otherwise);
 * - the response status is not 2xx (`code` is taken from an Ably-style `error.code` in the body, otherwise `statusCode * 100`);
 * - a 2xx response body is not valid JSON (code 50000).
 *
 * Credentials (cookies) are sent cross-origin when an `Authorization` header is set, as ably-js's XHR client did.
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
    delete headers['Content-Length']; // computed by fetch; setting it explicitly is refused by browsers
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
        response = await fetch(options.uri, {
            method: options.method.toUpperCase(),
            headers,
            body: options.body,
            credentials: hasHeader(headers, 'Authorization') ? 'include' : 'same-origin',
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
        const message = errorDetails?.message ?? (text !== '' && parseError ? text : response.statusText);
        throw httpError(`HTTP ${response.status}: ${message}`, response.status, errorDetails?.code ?? response.status * 100);
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
