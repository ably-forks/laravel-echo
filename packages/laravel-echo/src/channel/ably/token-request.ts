import { httpError } from "./utils";
import type { AblyTokenResponse } from "../../connector/ably-connector";

/** A token request: `authEndpoint`'s default, or the app's `requestTokenFn` (`channelName` is null for the connection). */
export type RequestTokenFn = (
    channelName: string | null,
    existingToken: string | null,
) => Promise<AblyTokenResponse>;

/** Upper bound for one token request, so a hung requestTokenFn cannot block every later auth request. */
export const TOKEN_REQUEST_TIMEOUT_MS = 30000;

/**
 * [provisional: P-08 (a)] A token response that looks like the Pusher protocol (`{auth: "key:signature"}`, no token):
 * the shape of Laravel's built-in `ably` broadcaster (F-190, F-191).
 */
export const PUSHER_PROTOCOL_RESPONSE_HINT =
    '@ably/laravel-echo: the auth endpoint returned a Pusher-protocol response (`{auth: "key:signature"}`) instead of an Ably token. ' +
    "This response comes from Laravel's built-in `ably` broadcaster, which `@ably/laravel-echo` does not support; " +
    'install `ably/laravel-broadcaster` v2 on the server. See "Troubleshooting" in the README.';

/**
 * A 403 on the connection token request (F-190). With no channel name, only these answer 403: Laravel's built-in `ably`
 * broadcaster (any version, `Ably2Broadcaster` included) refuses every request without one, so it comes first;
 * laravel-broadcaster v2 refuses a presented token it cannot re-sign; or a middleware on the route denies the request.
 * A stale CSRF token is a 419, and a missing session or auth guard does not give a 403 here.
 */
export const CONNECTION_TOKEN_REFUSED_HINT =
    "@ably/laravel-echo: the auth endpoint refused the connection token request (HTTP 403). " +
    "The most likely cause is that the server uses Laravel's built-in `ably` broadcaster, which refuses requests without a channel name; " +
    'install `ably/laravel-broadcaster` v2 (see "Troubleshooting" in the README). ' +
    "Other causes: a middleware on the broadcasting auth route denied the request, or the presented token could not be re-signed.";

/** The developer hints already logged: module state, so each is logged once per page, whatever the connectors. */
export const loggedAuthHints = new Set<string>();

/** Logs a developer hint with console.warn, once per page. */
export const warnOnce = (hint: string) => {
    if (loggedAuthHints.has(hint)) {
        return;
    }
    loggedAuthHints.add(hint);
    console.warn(hint);
};

/** An object with a string `auth` property: the Pusher-protocol auth response. */
const isPusherProtocolResponse = (response: unknown) =>
    typeof response === "object" &&
    response !== null &&
    typeof (response as { auth?: unknown }).auth === "string";

const withTimeout = <T>(
    promise: Promise<T>,
    ms: number,
    source: string,
): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(
                httpError(
                    `${source} did not complete within ${ms}ms`,
                    500,
                    50003,
                ),
            );
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export class SequentialAuthTokenRequestExecuter {
    cachedToken: string | null;
    queue: TaskQueue;
    requestTokenFn: RequestTokenFn;
    source: string;
    timeoutMs: number;

    constructor(
        token: string | null = null,
        requestTokenFn: RequestTokenFn,
        {
            source = "requestTokenFn",
            timeoutMs = TOKEN_REQUEST_TIMEOUT_MS,
        } = {},
    ) {
        this.cachedToken = token;
        this.source = source;
        this.timeoutMs = timeoutMs;
        this.requestTokenFn = requestTokenFn;
        this.queue = new TaskQueue();
    }

    execute = (
        tokenRequestFn: (
            existingToken: string | null,
        ) => Promise<AblyTokenResponse>,
    ): Promise<{ token: string; info: unknown }> =>
        new Promise((resolve, reject) => {
            // the task settles this promise itself and never rejects, so run()'s own promise is deliberately not awaited
            void this.queue.run(async () => {
                try {
                    const response = await withTimeout(
                        Promise.resolve().then(() =>
                            tokenRequestFn(this.cachedToken),
                        ),
                        this.timeoutMs,
                        this.source,
                    );
                    // a requestTokenFn may resolve with anything: checked below, whatever its declared type
                    const { token, info } = (response ??
                        {}) as Partial<AblyTokenResponse>;
                    // R12/T7: validate before caching, so a bad result never overwrites the cached token
                    if (typeof token !== "string" || token.trim() === "") {
                        if (isPusherProtocolResponse(response)) {
                            warnOnce(PUSHER_PROTOCOL_RESPONSE_HINT); // P-08 (a); the request still fails below
                        }
                        throw httpError(
                            `${this.source} returned a response without a token`,
                            500,
                            50000,
                        );
                    }
                    this.cachedToken = token;
                    resolve({ token, info });
                } catch (err) {
                    reject(err);
                }
            });
        });

    request = (
        channelName: string | null,
    ): Promise<{ token: string; info: unknown }> =>
        this.execute((token) => this.requestTokenFn(channelName, token));
}

type Task = () => Promise<void>;
class TaskQueue {
    total: number;
    todo: Array<Task>;
    running: Array<Task>;
    count: number;

    constructor(tasks: Array<Task> = [], concurrentCount = 1) {
        this.total = tasks.length;
        this.todo = tasks;
        this.running = [];
        this.count = concurrentCount;
    }

    canRunNext = () => this.running.length < this.count && this.todo.length;

    run = async (task: Task) => {
        if (task) {
            this.todo.push(task);
        }
        while (this.canRunNext()) {
            const currentTask = this.todo.shift();
            if (!currentTask) break; // canRunNext() checked todo.length; this only narrows the type
            this.running.push(currentTask);
            await currentTask();
            this.running.shift();
        }
    };
}
