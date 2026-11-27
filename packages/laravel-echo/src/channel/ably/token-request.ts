import { httpError } from './utils';

/** Upper bound for one token request, so a hung requestTokenFn cannot block every later auth request. */
export const TOKEN_REQUEST_TIMEOUT_MS = 30000;

const withTimeout = <T>(promise: Promise<T>, ms: number, source: string): Promise<T> => {
    let timer;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(httpError(`${source} did not complete within ${ms}ms`, 500, 50003));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export class SequentialAuthTokenRequestExecuter {
    cachedToken: string;
    queue: TaskQueue;
    requestTokenFn: Function;
    source: string;
    timeoutMs: number;

    constructor(
        token: string = null,
        requestTokenFn: Function,
        { source = 'requestTokenFn', timeoutMs = TOKEN_REQUEST_TIMEOUT_MS } = {}
    ) {
        this.cachedToken = token;
        this.source = source;
        this.timeoutMs = timeoutMs;
        this.requestTokenFn = requestTokenFn;
        this.queue = new TaskQueue();
    }

    execute = (tokenRequestFn: Function): Promise<{ token: string; info: any }> =>
        new Promise((resolve, reject) => {
            this.queue.run(async () => {
                try {
                    const response = await withTimeout(
                        Promise.resolve().then(() => tokenRequestFn(this.cachedToken)),
                        this.timeoutMs,
                        this.source
                    );
                    const { token, info } = response ?? {};
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

    request = (channelName: string): Promise<{ token: string; info: any }> =>
        this.execute((token) => this.requestTokenFn(channelName, token));
}

type Task = Function;
class TaskQueue {
    total: Number;
    todo: Array<Task>;
    running: Array<Task>;
    count: Number;

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
            this.running.push(currentTask);
            await currentTask();
            this.running.shift();
        }
    };
}
