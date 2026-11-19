module.exports = {
    testEnvironment: '<rootDir>/tests/setup/fetch-environment.js',
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    // tests/bundles needs `npm run build` first; run it with `npm run test:bundles` (jest.bundles.config.js)
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/bundles/'],
};
