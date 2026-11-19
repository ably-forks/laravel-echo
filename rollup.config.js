import babel from '@rollup/plugin-babel';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from 'rollup-plugin-typescript2';

// Single install: @ably/pubsub-device is a dependency. The ESM/CJS builds keep it external (the app's bundler or Node
// resolves it); the IIFE build bundles its browser build, so a script-tag page needs no Ably global.
const isAblyDevice = (id) => id === '@ably/pubsub-device' || id.startsWith('@ably/pubsub-device/');

const pluginsWith = (resolveOptions) => [
    nodeResolve({
        extensions: ['.js', '.ts'],
        ...resolveOptions,
    }),
    json(),
    typescript(),
    babel({
        babelHelpers: 'bundled',
        exclude: 'node_modules/**',
        extensions: ['.ts'],
        presets: ['@babel/preset-env', '@babel/preset-typescript'],
        plugins: [
            ['@babel/plugin-proposal-decorators', { legacy: true }],
            '@babel/plugin-proposal-function-sent',
            '@babel/plugin-proposal-export-namespace-from',
            '@babel/plugin-proposal-numeric-separator',
            '@babel/plugin-proposal-throw-expressions',
            '@babel/plugin-transform-object-assign',
        ],
    }),
];

export default [
    {
        input: './src/echo.ts',
        output: [
            { file: './dist/echo.js', format: 'esm' },
            { file: './dist/echo.common.js', format: 'cjs' },
        ],
        external: isAblyDevice,
        plugins: pluginsWith({}),
    },
    {
        input: './src/index.iife.ts',
        output: [{ file: './dist/echo.iife.js', format: 'iife', name: 'Echo' }],
        plugins: pluginsWith({ extensions: ['.mjs', '.js', '.ts'], browser: true, exportConditions: ['browser'] }),
    },
];
