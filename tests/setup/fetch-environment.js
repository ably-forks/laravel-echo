// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeEnvironment = require('jest-environment-node');

/**
 * Jest 27's node environment does not expose Node's built-in `fetch` (Node 18+) to tests,
 * which the Ably connector uses to call the auth endpoint.
 */
class FetchEnvironment extends NodeEnvironment {
    constructor(config, context) {
        super(config, context);
        Object.assign(this.global, { fetch, Headers, Request, Response });
    }
}

module.exports = FetchEnvironment;
