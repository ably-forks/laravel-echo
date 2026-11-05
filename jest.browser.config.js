// Runs the Ably integration tests against @ably/pubsub-device's *browser* build (dist/index.js) instead of the
// Node build that Jest resolves through package.json "main" (review R15). Browser builds are JSON-only and
// log-stripped, and use browser transports.
const base = require('./jest.config');

module.exports = {
    ...base,
    testEnvironment: '<rootDir>/tests/setup/browser-build-environment.js',
    testMatch: ['<rootDir>/tests/ably/**/*.test.ts'],
    moduleNameMapper: {
        '^@ably/pubsub-device$': '<rootDir>/node_modules/@ably/pubsub-device/dist/index.js',
    },
};
