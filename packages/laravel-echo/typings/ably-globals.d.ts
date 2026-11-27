// Replaced at build time by the `define` in vite.config.ts with package.json's version (E-05).
declare const __ECHO_VERSION__: string;

// The legacy Ably globals (`window.Ably = Ably`, the CDN bundle). Echo never uses their values: they are only probed
// with `typeof` by warnIfAblyGlobalsIgnored(), so `unknown` is enough.
declare const Ably: unknown;
declare const AblyPubSub: unknown;
