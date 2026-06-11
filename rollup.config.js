import babel from '@rollup/plugin-babel';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from 'rollup-plugin-typescript2';

const plugins = [
    nodeResolve({
        extensions: ['.js', '.ts'],
    }),
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
        plugins,
    },
    {
        input: './src/index.iife.ts',
        output: [{ file: './dist/echo.iife.js', format: 'iife', name: 'Echo' }],
        plugins,
    },
];
