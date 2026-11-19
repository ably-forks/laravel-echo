// Smoke tests of the built bundles (dist/). Run after `npm run build`: `npm run test:bundles`.
const base = require('./jest.config');

module.exports = {
    ...base,
    testPathIgnorePatterns: ['/node_modules/'],
    testMatch: ['<rootDir>/tests/bundles/**/*.test.ts'],
};
