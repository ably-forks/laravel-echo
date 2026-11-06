import { httpDeleteAsync, httpPostAsync, toBase64UrlEncoded } from './utils';

let sandboxUrl = 'https://sandbox-rest.ably.io/apps';

const SETUP_ATTEMPTS = 3;
const SETUP_ATTEMPT_TIMEOUT_MS = 5000;

/**
 * Creates a sandbox app. The sandbox occasionally times out (50003) or fails at the network level (50000); retry
 * those up to 3 attempts of 5 s with a short backoff, so a transient outage doesn't fail a whole suite. The worst
 * case (3 x 5 s + 1 s + 2 s = 18 s) fits the 20 s beforeAll timeout of the shortest sandbox suites.
 */
const creatNewApp = async () => {
    let body = {
        keys: [{}],
        namespaces: [],
    };
    for (let attempt = 1; ; attempt++) {
        try {
            const res: {
                appId: string;
                keys: { keyStr: string }[];
            } = await httpPostAsync(sandboxUrl, body, SETUP_ATTEMPT_TIMEOUT_MS);
            return res;
        } catch (err: any) {
            const transient = err?.code === 50003 || err?.code === 50000 || (err?.statusCode ?? 0) >= 500;
            if (!transient || attempt >= SETUP_ATTEMPTS) {
                throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    }
};

const deleteApp = async (app) => {
    let authKey = app.keys[0].keyStr;
    const headers = { Authorization: 'Basic ' + toBase64UrlEncoded(authKey) };
    return await httpDeleteAsync(`${sandboxUrl}/${app.appId}`, headers);
};

export { creatNewApp as setup, deleteApp as tearDown };
