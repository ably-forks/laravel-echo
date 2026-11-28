import { httpDeleteAsync, httpPostAsync, toBase64UrlEncoded } from "./utils";

let sandboxUrl = "https://sandbox-rest.ably.io/apps";

const SETUP_ATTEMPTS = 3;
const SETUP_ATTEMPT_TIMEOUT_MS = 5000;

/**
 * Creates a sandbox app. The sandbox occasionally times out (50003) or fails at the network level (50000); retry
 * those up to 3 attempts of 5 s with a short backoff, so a transient outage doesn't fail a whole suite. The worst
 * case (3 x 5 s + 1 s + 2 s = 18 s) fits the 20 s beforeAll timeout of the shortest sandbox suites.
 */
export interface SetupOptions {
    /**
     * Create the app on a MAU-enforced test account (`mauEnforced` in the sandbox app spec): connections need an
     * identified client, so a null or '*' clientId is refused with 40161. Guests of laravel-broadcaster v2 (and the mock
     * auth server) always have a guest client id; only a token without a clientId, as a custom auth endpoint may sign,
     * is refused. Absent (the default) leaves enforcement off.
     */
    mau?: boolean;
}

const creatNewApp = async (options: SetupOptions = {}) => {
    const body: Record<string, unknown> = {
        keys: [{}],
        namespaces: [],
        ...(options.mau ? { mauEnforced: true } : {}),
    };
    for (let attempt = 1; ; attempt++) {
        try {
            const res: {
                appId: string;
                keys: { keyStr: string }[];
            } = await httpPostAsync(sandboxUrl, body, SETUP_ATTEMPT_TIMEOUT_MS);
            return res;
        } catch (err: any) {
            const transient =
                err?.code === 50003 ||
                err?.code === 50000 ||
                (err?.statusCode ?? 0) >= 500;
            if (!transient || attempt >= SETUP_ATTEMPTS) {
                throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    }
};

/**
 * Deletes a sandbox app. Teardown only: when setup() failed there is no app (or no key) and nothing is deleted, and a
 * failed or timed-out delete is reported as a warning, not an error, so it cannot fail a file whose tests passed.
 * The delete keeps httpRequestAsync's default 10 s timeout, inside every suite's hook timeout. Creation failures stay
 * fatal (setup() throws).
 */
const deleteApp = async (
    app:
        | {
              appId: string;
              keys: { keyStr: string }[];
          }
        | null
        | undefined,
) => {
    const authKey = app?.keys?.[0]?.keyStr;
    if (!app?.appId || !authKey) {
        return;
    }
    const headers = { Authorization: "Basic " + toBase64UrlEncoded(authKey) };
    try {
        return await httpDeleteAsync(`${sandboxUrl}/${app.appId}`, headers);
    } catch (err: any) {
        process.emitWarning(
            `Sandbox app ${app.appId} was not deleted: ${err?.message ?? String(err)}`,
        );
    }
};

export { creatNewApp as setup, deleteApp as tearDown };
