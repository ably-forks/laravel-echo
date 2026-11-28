import { httpRequestAsync } from "../../../src/channel/ably/utils";
import type Echo from "../../../src/echo";
import type {
    AblyRealtimeChannel,
    ConnectionStateChange,
    ErrorInfo,
} from "../../../src/types/ably";
export { toBase64UrlEncoded } from "../../../src/channel/ably/utils";

/**
 * Disconnects the client and resolves once its connection is closed (or failed, which also ends it). Listens before
 * disconnecting, so a fast close is not missed, and resolves at once if the connection has already ended.
 */
export const closeConnection = (echo: Echo<"ably">) =>
    new Promise<void>((resolve) => {
        const connection = echo.connector.ably.connection;
        if (connection.state === "closed" || connection.state === "failed") {
            return resolve();
        }
        const onStateChange = (change: ConnectionStateChange) => {
            if (change.current === "closed" || change.current === "failed") {
                connection.off(onStateChange);
                resolve();
            }
        };
        connection.on(onStateChange);
        echo.disconnect();
    });

/** How long before the test's own timeout a diagnostic wait gives up, so its error is the one vitest reports. */
export const DIAGNOSTIC_MARGIN_MS = 500;

const describeState = (state: string, errorReason?: ErrorInfo | null) =>
    `${state} (last error: ${errorReason ? `${errorReason.code} ${errorReason.message}` : "none"})`;

const describeError = (err: unknown) => {
    if (!err || typeof err !== "object") {
        return String(err);
    }
    const e = err as {
        code?: number | string;
        statusCode?: number | string;
        message?: string;
    };
    let text = e.message;
    if (text === undefined) {
        try {
            text = JSON.stringify(err);
        } catch {
            text = Object.prototype.toString.call(err); // e.g. a circular object
        }
    }
    return [e.code, e.statusCode, text]
        .filter((part) => part !== undefined)
        .join(" ");
};

/** How many Ably log lines a timed-out wait reports, and how long each may be. */
export const ABLY_LOG_TAIL_LINES = 50;
const ABLY_LOG_LINE_CHARS = 400;

/**
 * A bounded tail of an Ably client's log, for the diagnostic of a timed-out wait. Spread `clientOptions` into the Echo
 * options (Echo passes Ably client options through): it logs at level 4, which includes the protocol messages (so a
 * missing presence echo is visible), into a ring buffer of the last {@link ABLY_LOG_TAIL_LINES} lines, each cut to
 * 400 characters. Errors (level 1) still go to stderr, as the default handler would print them.
 */
export const createAblyLogTail = (limit = ABLY_LOG_TAIL_LINES) => {
    const tail: string[] = [];
    return {
        clientOptions: {
            logLevel: 4,
            logHandler: (msg: string, level: number) => {
                tail.push(
                    `${new Date().toISOString()} [${level}] ${msg.slice(0, ABLY_LOG_LINE_CHARS)}`,
                );
                if (tail.length > limit) {
                    tail.shift();
                }
                if (level <= 1) {
                    process.stderr.write(`${msg}\n`);
                }
            },
        },
        lines: () => [...tail],
    };
};

/** Extra state a timed-out presence wait reports; see {@link watchPresence}. */
export type PresenceWatch = {
    lastAttachResumed: () => boolean | undefined;
    errors: () => unknown[];
};

/**
 * Records, for the diagnostic of a timed-out presence wait, the `resumed` flag of the channel's last attach and the
 * errors reported to the channel's error() listeners (the presence enter's and subscribe's failures; the last 5). It
 * only observes: nothing fails on them.
 */
export const watchPresence = (presenceChannel: {
    channel: AblyRealtimeChannel;
    error: (callback: CallableFunction) => unknown;
}): PresenceWatch => {
    let lastAttachResumed: boolean | undefined;
    const errors: unknown[] = [];
    presenceChannel.channel.on("attached", (stateChange) => {
        lastAttachResumed = stateChange?.resumed;
    });
    presenceChannel.error((err: unknown) => {
        errors.push(err);
        if (errors.length > 5) {
            errors.shift();
        }
    });
    return {
        lastAttachResumed: () => lastAttachResumed,
        errors: () => [...errors],
    };
};

/** Presence state for the diagnostic: members seen locally (no attach or sync wait, at most 250 ms). */
const describePresence = async (channel: AblyRealtimeChannel) => {
    const parts = [
        `presence syncComplete ${String(channel.presence.syncComplete)}`,
    ];
    if (channel.state !== "attached") {
        parts.push(`members not read (channel ${channel.state})`);
        return parts;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const members = await Promise.race([
            channel.presence.get({ waitForSync: false }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error("no answer within 250 ms")),
                    250,
                );
            }),
        ]);
        parts.push(
            `members ${members.length} [${members.map((m) => m.clientId).join(", ")}]`,
        );
    } catch (err) {
        parts.push(`members unavailable (${describeError(err)})`);
    } finally {
        clearTimeout(timer);
    }
    return parts;
};

/**
 * Waits for `event` for as long as the test allows. Just before the test's timeout it rejects with the Ably state
 * instead of leaving vitest to report a bare "Test timed out": the connection state, the channel state where there is
 * a channel, and their last error reasons. For a presence channel it adds the last enter's outcome
 * (`lastEnterSucceeded`), the presence sync state and the locally known members. With `details`, it also adds the
 * last attach's `resumed` flag and the channel's errors ({@link watchPresence}) and the Ably log tail
 * ({@link createAblyLogTail}). Pass the test context's `task`: its `timeout` is the test's timeout.
 */
export const waitWithDiagnostics = <T>(
    event: Promise<T>,
    waitingFor: string,
    task: { timeout: number },
    echo: Echo<"ably">,
    channel?: { channel: AblyRealtimeChannel; lastEnterSucceeded?: boolean },
    details?: Partial<PresenceWatch> & { logTail?: () => string[] },
): Promise<T> => {
    // No usable timeout (0, unset, or not above the margin): never give up before the test does; just wait.
    if (!(task.timeout > DIAGNOSTIC_MARGIN_MS)) {
        return event;
    }
    const describe = async () => {
        const connection = echo.connector.ably.connection;
        const parts = [
            `connection ${describeState(connection.state, connection.errorReason)}`,
        ];
        const lines: string[] = [];
        if (channel) {
            parts.push(
                `channel ${channel.channel.name} ${describeState(channel.channel.state, channel.channel.errorReason)}`,
            );
            if ("lastEnterSucceeded" in channel) {
                parts.push(
                    `lastEnterSucceeded ${String(channel.lastEnterSucceeded)}`,
                    ...(await describePresence(channel.channel)),
                );
            }
        }
        if (details?.lastAttachResumed) {
            parts.push(
                `last attach resumed ${String(details.lastAttachResumed())}`,
            );
        }
        if (details?.errors) {
            const errors = details.errors();
            parts.push(
                `channel errors ${errors.length ? errors.map(describeError).join(" | ") : "none"}`,
            );
        }
        if (details?.logTail) {
            const tail = details.logTail();
            lines.push(
                `Ably log (last ${tail.length} lines):`,
                ...tail.map((line) => `  ${line}`),
            );
        }
        return [
            `Timed out waiting for ${waitingFor}: ${parts.join("; ")}`,
            ...lines,
        ].join("\n");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            void describe().then(
                (message) => reject(new Error(message)),
                (err) =>
                    reject(
                        new Error(
                            `Timed out waiting for ${waitingFor} (diagnostic failed: ${describeError(err)})`,
                        ),
                    ),
            );
        }, task.timeout - DIAGNOSTIC_MARGIN_MS);
    });
    return Promise.race([event, expired]).finally(() => clearTimeout(timer));
};

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
