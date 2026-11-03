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

let httpClient: any;
function httpRequest(options, callback) {
    if (!httpClient) {
        httpClient = new Ably.Rest.Platform.Http();
    }
    // Automatically set by browser
    options.method = options.method.toLowerCase();
    if (isBrowser) {
        delete options.headers['Content-Length']; // XHR warning - Refused to set unsafe header "Content-Length"
    }
    httpClient
        .doUri(options.method, options.uri, options.headers, options.body, options.paramsIfNoHeaders || {})
        .then((result) => callback(result.error, result.body))
        .catch(callback);
}

export const httpRequestAsync = (options): Promise<any> => {
    return new Promise((resolve, reject) => {
        httpRequest(options, function (err: any, res: any) {
            if (err) {
                reject(err);
            } else {
                if (typeof res === 'string') {
                    resolve(JSON.parse(res));
                } else if (!isBrowser && Buffer.isBuffer(res)) {
                    try {
                        resolve(JSON.parse(res.toString()));
                    } catch (e) {
                        resolve(res);
                    }
                } else {
                    resolve(res);
                }
            }
        });
    });
};
