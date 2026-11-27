import { httpRequestAsync } from "../../../src/channel/ably/utils";
export { toBase64UrlEncoded } from "../../../src/channel/ably/utils";

/** The resolve/reject pair of the promise a callback-style test returns. */
export type Settle = {
    resolve: () => void;
    reject: (reason?: unknown) => void;
};

// Runs assertions inside an event callback: a failure rejects the test's promise; the final assertion resolves it.
const safeAssert = (
    assertions: Function,
    settle: Settle,
    finalAssertion = false,
) => {
    try {
        assertions();
        if (finalAssertion) {
            settle.resolve();
        }
    } catch (err) {
        settle.reject(err);
    }
};

export const execute = (fn: Function, times: number) => {
    while (times--) {
        fn();
    }
};

export const httpPostAsync = async (
    url: string,
    postData: any,
    timeoutMs?: number,
) => {
    postData = JSON.stringify(postData);
    let postOptions = {
        uri: url,
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: postData,
    };
    return await httpRequestAsync(postOptions, timeoutMs);
};

export const httpDeleteAsync = async (url: string, headers: any) => {
    let deleteOptions = {
        uri: url,
        method: "DELETE",
        headers,
    };
    return await httpRequestAsync(deleteOptions);
};

export default safeAssert;
