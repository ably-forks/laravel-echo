/**
 * Counting stand-in for the `ws` package, for sandbox tests that assert how many WebSockets ably-js opens.
 * Use it in a test file (jest.mock is file-wide, so keep such tests in their own file):
 *
 *   jest.mock('ws', () => require('./setup/ws-counter').createCountingWs(jest.requireActual('ws')));
 *
 * and read `recordedSockets()` / `connectedFrameCount()`. Use `useBinaryProtocol: false` so frames are JSON.
 */
export const createCountingWs = (Real: any) => {
    // the factory runs in the test's module registry: share the log through a global
    const g: any = global as any;
    g.__echoWsSockets = g.__echoWsSockets ?? [];
    return class CountingWs extends Real {
        constructor(...args: any[]) {
            super(...args);
            const entry = { url: String(args[0]), frames: [] as any[] };
            g.__echoWsSockets.push(entry);
            this.on('message', (data: any) => {
                try {
                    const m = JSON.parse(data.toString());
                    entry.frames.push({ action: m.action, error: m.error, connectionId: m.connectionId });
                } catch {
                    entry.frames.push({ action: -1 });
                }
            });
        }
    };
};

/** Sockets recorded by the counting `ws` mock since the last reset. */
export const recordedSockets = (): Array<{ url: string; frames: Array<{ action: number; error?: any; connectionId?: string }> }> =>
    (global as any).__echoWsSockets ?? [];
export const resetRecordedSockets = () => {
    (global as any).__echoWsSockets = [];
};
/**
 * Sockets that received a CONNECTED (action 4). An in-band authorize() makes the server send another CONNECTED on the
 * same socket, so count sockets (and connection ids), not frames.
 */
export const socketsWithConnected = () => recordedSockets().filter((s) => s.frames.some((f) => f.action === 4)).length;
export const connectionIds = () =>
    Array.from(new Set(recordedSockets().flatMap((s) => s.frames.filter((f) => f.action === 4).map((f) => f.connectionId))));

/**
 * The browser build of @ably/pubsub-device (jest.browser.config.js) opens sockets through the global WebSocket, not
 * `ws`: count those too. Idempotent. It runs when this module is imported, so import it before anything that loads ably (the browser build may keep a reference to the global WebSocket it finds at load time).
 */
export const countGlobalWebSocket = () => {
    const g: any = global as any;
    const Native = g.WebSocket;
    if (!Native || Native.__echoCounting) return;
    g.__echoWsSockets = g.__echoWsSockets ?? [];
    class CountingWebSocket extends Native {
        static __echoCounting = true;
        constructor(...args: any[]) {
            super(...args);
            const entry = { url: String(args[0]), frames: [] as any[] };
            g.__echoWsSockets.push(entry);
            this.addEventListener('message', (event: any) => {
                try {
                    const m = JSON.parse(String(event.data));
                    entry.frames.push({ action: m.action, error: m.error, connectionId: m.connectionId });
                } catch {
                    entry.frames.push({ action: -1 });
                }
            });
        }
    }
    g.WebSocket = CountingWebSocket;
};

countGlobalWebSocket();
