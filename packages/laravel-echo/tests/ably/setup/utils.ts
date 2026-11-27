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

/**
 * Waits for `event` for as long as the test allows. Just before the test's timeout it rejects with the Ably state
 * (connection state, channel state where there is a channel, and their last error reasons) instead of leaving
 * vitest to report a bare "Test timed out". Pass the test context's `task`: its `timeout` is the test's timeout.
 */
export const waitWithDiagnostics = <T>(
    event: Promise<T>,
    waitingFor: string,
    task: { timeout: number },
    echo: Echo<"ably">,
    channel?: { channel: AblyRealtimeChannel },
): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const connection = echo.connector.ably.connection;
            const parts = [
                `connection ${describeState(connection.state, connection.errorReason)}`,
            ];
            if (channel) {
                parts.push(
                    `channel ${channel.channel.name} ${describeState(channel.channel.state, channel.channel.errorReason)}`,
                );
            }
            reject(
                new Error(
                    `Timed out waiting for ${waitingFor}: ${parts.join("; ")}`,
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
