/* eslint-disable @typescript-eslint/no-var-requires */
const NodeEnvironment = require('jest-environment-node');
const { webcrypto } = require('crypto');

/**
 * Exposes the web-platform globals that @ably/pubsub-device's browser build (dist/index.js) needs, so the Ably
 * tests can run against it under Node (>= 22 provides a global WebSocket).
 */
class BrowserBuildEnvironment extends NodeEnvironment {
    constructor(config, context) {
        super(config, context);
        Object.assign(this.global, {
            fetch, Headers, Request, Response, WebSocket, TextEncoder, TextDecoder, atob, btoa,
            crypto: webcrypto, AbortController, queueMicrotask,
        });
    }
}

module.exports = BrowserBuildEnvironment;
