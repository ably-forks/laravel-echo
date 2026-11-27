/**
 * F-057: AblyChannel inherits upstream's notification() and stopListeningForNotification(callback). The dotted
 * notification event must reach Ably as the un-namespaced Laravel class name, and removal must be per callback.
 * No network: Ably runs on tests/parity/fake-ably.ts.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import Echo from "../../src/echo";
import { makeFakeAblyClient } from "../parity/fake-ably";

const EVENT = "Illuminate\\Notifications\\Events\\BroadcastNotificationCreated";

const setup = () => {
    const echo = new Echo({ broadcaster: "ably", client: makeFakeAblyClient(), withoutInterceptors: true });
    const channel = echo.private("App.Models.User.1");
    // any: the fake ably channel (tests/parity/fake-ably.ts) and its message emitter
    const fake: any = channel.channel;
    const deliver = (data: unknown) => fake.messages.emit(EVENT, { name: EVENT, data, id: "m1", timestamp: 1 });
    return { channel, fake, deliver };
};

describe("notification() round trip (F-057)", () => {
    test("notification(cb) subscribes to the formatted BroadcastNotificationCreated event", () => {
        const { channel, fake, deliver } = setup();
        const cb = vi.fn();

        expect(channel.notification(cb)).toBe(channel);
        expect(fake.subscribe).toHaveBeenCalledWith(EVENT, expect.any(Function));

        deliver({ id: "n1", type: "App\\Notifications\\Shipped" });
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toEqual({ id: "n1", type: "App\\Notifications\\Shipped" });
        expect(cb.mock.calls[0][1]).toEqual({ name: EVENT, id: "m1", timestamp: 1 }); // the message metadata, no data
    });

    test("stopListeningForNotification(cb) removes exactly that callback", () => {
        const { channel, deliver } = setup();
        const removed = vi.fn();
        const kept = vi.fn();
        channel.notification(removed).notification(kept);

        expect(channel.stopListeningForNotification(removed)).toBe(channel);
        deliver({ id: "n2" });

        expect(removed).not.toHaveBeenCalled();
        expect(kept).toHaveBeenCalledExactlyOnceWith({ id: "n2" }, expect.anything());
    });

    test("a callback registered again after removal is called once per notification", () => {
        const { channel, deliver } = setup();
        const cb = vi.fn();

        channel.notification(cb);
        channel.stopListeningForNotification(cb);
        channel.notification(cb);
        deliver({ id: "n3" });

        expect(cb).toHaveBeenCalledExactlyOnceWith({ id: "n3" }, expect.anything());
    });

    test("listen() on the same event is not removed by stopListeningForNotification(other)", () => {
        const { channel, deliver } = setup();
        const viaListen = vi.fn();
        const other = vi.fn();
        channel.listen(".Illuminate\\Notifications\\Events\\BroadcastNotificationCreated", viaListen);
        channel.notification(other);

        channel.stopListeningForNotification(other);
        deliver({ id: "n4" });

        expect(viaListen).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();
    });
});
