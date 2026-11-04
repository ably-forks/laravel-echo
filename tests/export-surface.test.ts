/**
 * Guards the package's runtime export surface (R26). `import type` is elided by TypeScript, so a value export
 * that is accidentally imported as a type silently disappears from the ESM/CJS bundles.
 */
import * as EchoModule from '../src/echo';

describe('export surface', () => {
    test('runtime named exports match 1.0.6', () => {
        expect(Object.keys(EchoModule).sort()).toEqual(['Channel', 'Connector', 'EventFormatter', 'default']);
    });

    test('Channel is a runtime value (abstract class), usable with instanceof / extends', () => {
        const { Channel } = EchoModule as any;
        expect(typeof Channel).toBe('function');
        abstract class MyChannel extends EchoModule.Channel {} // TS1361/TS2339 if Channel is type-only
        expect(Object.getPrototypeOf(MyChannel)).toBe(Channel);
    });
});
