import { httpError } from './utils';
import type { AblyTokenResponse } from '../../connector/ably-connector';

/** A token request: `authEndpoint`'s default, or the app's `requestTokenFn` (`channelName` is null for the connection). */
export type RequestTokenFn = (channelName: string | null, existingToken: string | null) => Promise<AblyTokenResponse>;

/** Upper bound for one token request, so a hung requestTokenFn cannot block every later auth request. */
export const TOKEN_REQUEST_TIMEOUT_MS = 30000;

const withTimeout = <T>(promise: Promise<T>, ms: number, source: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(httpError(`${source} did not complete within ${ms}ms`, 500, 50003));
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
        { source = 'requestTokenFn', timeoutMs = TOKEN_REQUEST_TIMEOUT_MS } = {}
    ) {
        this.cachedToken = token;
        this.source = source;
        this.timeoutMs = timeoutMs;
        this.requestTokenFn = requestTokenFn;
        this.queue = new TaskQueue();
    }

    execute = (
        tokenRequestFn: (existingToken: string | null) => Promise<AblyTokenResponse>
    ): Promise<{ token: string; info: unknown }> =>
        new Promise((resolve, reject) => {
            this.queue.run(async () => {
                try {
                    const response = await withTimeout(
                        Promise.resolve().then(() => tokenRequestFn(this.cachedToken)),
                        this.timeoutMs,
                        this.source
                    );
                    // a requestTokenFn may resolve with anything: checked below, whatever its declared type
                    const { token, info } = (response ?? {}) as Partial<AblyTokenResponse>;
                    // R12/T7: validate before caching, so a bad result never overwrites the cached token
                    if (typeof token !== 'string' || token.trim() === '') {
                        throw httpError(`${this.source} returned a response without a token`, 500, 50000);
                    }
                    this.cachedToken = token;
                    resolve({ token, info });
                } catch (err) {
                    reject(err);
                }
            });
        });

    request = (channelName: string | null): Promise<{ token: string; info: unknown }> =>
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
