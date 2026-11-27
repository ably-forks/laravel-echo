import Echo, { Channel, Connector, EventFormatter } from './echo';

/**
 * The IIFE global `window.Echo`. Fork (E-02): it is the Echo class itself, so the 1.x form `new Echo({...})` works.
 * Upstream's IIFE global is the module namespace instead (`new Echo.default({...})`, `Echo.Channel`, ...), so its
 * members are attached to the class too and both forms work (additive upstream compatibility). This entry is only
 * used by the IIFE build; the ESM/CJS builds export the class unchanged.
 */
export default Object.assign(Echo, { default: Echo, Channel, Connector, EventFormatter });
