import { fromBase64UrlEncoded, parseJwt, toBase64UrlEncoded, toTokenDetails } from '../../src/channel/ably/utils';

describe('Utils', () => {
    describe('JWT handling', () => {
        test('should parse JWT properly', () => {
            const token =
            'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiIsImtpZCI6ImFiY2QifQ.eyJpYXQiOjE2NTQ2MzQyMTIsImV4cCI6MTY1NDYzNzgxMiwieC1hYmx5LWNsaWVudElkIjoidXNlcjEyMyIsIngtYWJseS1jYXBhYmlsaXR5Ijoie1wicHVibGljOipcIjpbXCJzdWJzY3JpYmVcIixcImhpc3RvcnlcIixcImNoYW5uZWwtbWV0YWRhdGFcIl19In0.GenM5EyUeJvgAGBD_EG-89FueNKWtyRZyi61s9G2Bs4';
            const expectedHeader = {
                alg: 'HS256',
                kid: 'abcd',
                typ: 'JWT',
            };
            const expectedPayload = {
                iat: 1654634212,
                exp: 1654637812,
                'x-ably-clientId': 'user123',
                'x-ably-capability': '{"public:*":["subscribe","history","channel-metadata"]}',
            };

            expect(parseJwt(token).header).toStrictEqual(expectedHeader);
            expect(parseJwt(token).payload).toStrictEqual(expectedPayload);
        });
    
        test('should convert to tokenDetails', () => {
            const token =
            'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiIsImtpZCI6ImFiY2QifQ.eyJpYXQiOjE2NTQ2MzQyMTIsImV4cCI6MTY1NDYzNzgxMiwieC1hYmx5LWNsaWVudElkIjoidXNlcjEyMyIsIngtYWJseS1jYXBhYmlsaXR5Ijoie1wicHVibGljOipcIjpbXCJzdWJzY3JpYmVcIixcImhpc3RvcnlcIixcImNoYW5uZWwtbWV0YWRhdGFcIl19In0.GenM5EyUeJvgAGBD_EG-89FueNKWtyRZyi61s9G2Bs4';
            const tokenDetails = toTokenDetails(token);
            expect(tokenDetails.clientId).toBe('user123');
            expect(tokenDetails.expires).toBe(1654637812000);
            expect(tokenDetails.issued).toBe(1654634212000);
            expect(tokenDetails.token).toBe(token);
        });

        test('should throw error for invalid JWT', () => {
            const invalidToken = 'invalid.token.string';
            expect(() => parseJwt(invalidToken)).toThrow('Unexpected token');
        });
    });

    describe('Base64 URL encoding/decoding', () => {
        test('should encode text into Base64UrlEncoded string', () => {
            const normalText = "laravel-echo codebase is of best quality, period!"
            const encodedText = toBase64UrlEncoded(normalText);
            expect(encodedText).toBe('bGFyYXZlbC1lY2hvIGNvZGViYXNlIGlzIG9mIGJlc3QgcXVhbGl0eSwgcGVyaW9kIQ')

            // edge cases
            expect(toBase64UrlEncoded('')).toBe('');
            expect(toBase64UrlEncoded('Hello, 世界! 🌍')).toBe('SGVsbG8sIOS4lueVjCEg8J-MjQ');
            expect(toBase64UrlEncoded('Hello+World/123')).toBe('SGVsbG8rV29ybGQvMTIz');
            expect(toBase64UrlEncoded('a')).toBe('YQ');  // Would be 'YQ==' in standard Base64
            expect(toBase64UrlEncoded('\x8EÇdwïìvÇ')).toBe('wo7Dh2R3w6_DrHbDhw');
        });

        test('should decode Base64UrlEncoded string into text', () => {
            const normalText = "bGFyYXZlbC1lY2hvIGNvZGViYXNlIGlzIG9mIGJlc3QgcXVhbGl0eSwgcGVyaW9kIQ"
            const encodedText = fromBase64UrlEncoded(normalText);
            expect(encodedText).toBe('laravel-echo codebase is of best quality, period!')

            // edge cases 
            expect(fromBase64UrlEncoded('')).toBe('');
            expect(fromBase64UrlEncoded('SGVsbG8sIOS4lueVjCEg8J-MjQ')).toBe('Hello, 世界! 🌍');
            expect(fromBase64UrlEncoded('SGVsbG8rV29ybGQvMTIz')).toBe('Hello+World/123');
            expect(fromBase64UrlEncoded('YQ')).toBe('a');  // No padding in Base64Url
            expect(fromBase64UrlEncoded('wo7Dh2R3w6_DrHbDhw')).toBe('\x8EÇdwïìvÇ');
        });
    });

    describe('P8: UTF-8 base64 in browsers', () => {
        const text = 'Zoë 日本';

        // utils.ts decides browser vs Node once, at import time: load fresh copies of the modules with a `window` global
        const requireInBrowser = (path: string) => {
            let loaded: any;
            (globalThis as any).window = {};
            try {
                jest.isolateModules(() => {
                    loaded = require(path);
                });
            } finally {
                delete (globalThis as any).window;
            }
            return loaded;
        };

        test('the browser path round-trips non-Latin-1 text and matches the Node (Buffer) encoding', () => {
            const browser = requireInBrowser('../../src/channel/ably/utils');
            const encoded = browser.toBase64UrlEncoded(text);
            expect(encoded).toBe(toBase64UrlEncoded(text)); // Node path: Buffer
            expect(browser.fromBase64UrlEncoded(encoded)).toBe(text);
            expect(fromBase64UrlEncoded(encoded)).toBe(text);
            expect(browser.toBase64UrlEncoded('Hello, 世界! 🌍')).toBe('SGVsbG8sIOS4lueVjCEg8J-MjQ');
            expect(browser.fromBase64UrlEncoded('SGVsbG8sIOS4lueVjCEg8J-MjQ')).toBe('Hello, 世界! 🌍');
        });

        test('socketId() works for a non-Latin-1 clientId in a browser', () => {
            const { AblyConnector } = requireInBrowser('../../src/connector/ably-connector');
            const socketId = AblyConnector.prototype.socketId.call({
                ably: { connection: { key: 'conn-key' }, auth: { clientId: text } },
            });
            expect(JSON.parse(fromBase64UrlEncoded(socketId))).toEqual({ connectionKey: 'conn-key', clientId: text });
        });

        test('a JWT with a non-Latin-1 clientId decodes in a browser', () => {
            const browser = requireInBrowser('../../src/channel/ably/utils');
            const payload = toBase64UrlEncoded(JSON.stringify({ 'x-ably-clientId': text, exp: 2, iat: 1 }));
            const jwt = `${toBase64UrlEncoded(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${payload}.sig`;
            expect(browser.toTokenDetails(jwt).clientId).toBe(text);
        });
    });
});

