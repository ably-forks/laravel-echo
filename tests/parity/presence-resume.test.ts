/**
 * Presence auto-enter on a resumed attach (review T15): ably re-enters a member it already has (RTP17), so Echo skips
 * its own enter on a resumed attach, unless the last enter() failed and there is no membership to restore.
 */
import { AblyPresenceChannel } from '../../src/channel';
import { ECHO_OPTIONS, ablyError, makeFakeAbly, settle, stubAuth } from './fake-ably';

const resume = (fake: any) => {
    // connection resumed: ably moves attached -> attaching -> attached(resumed)
    fake.transition('attaching');
    fake.state = 'attached';
    fake.stateEmitter.emit('attached', { previous: 'attaching', current: 'attached', resumed: true });
};

const setup = (name: string) => {
    const ably = makeFakeAbly();
    const echoChannel = new AblyPresenceChannel(ably, name, ECHO_OPTIONS, stubAuth);
    const errorListener = jest.fn();
    echoChannel.error(errorListener);
    return { fake: ably.channels.get(name), echoChannel, errorListener };
};

describe('presence auto-enter on a resumed attach', () => {
    test('the last enter() failed: a resumed attach enters again', async () => {
        const { fake, errorListener } = setup('presence:failed-enter');
        const err = ablyError('presence denied', 40160);
        fake.presence.enter.mockImplementationOnce(() => Promise.reject(err));
        fake.transition('attached');
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(1);
        expect(errorListener.mock.calls).toEqual([[err]]);
        resume(fake);
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(2);
    });

    test('the last enter() succeeded: a resumed attach relies on ably and does not enter again', async () => {
        const { fake } = setup('presence:entered');
        fake.transition('attached');
        await settle();
        resume(fake);
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(1);
    });

    test('an enter() still in flight is not duplicated by a resumed attach', async () => {
        const { fake } = setup('presence:in-flight');
        let finish: () => void = () => undefined;
        fake.presence.enter.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
        fake.transition('attached');
        resume(fake);
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(1);
        finish();
        await settle();
        resume(fake);
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(1);
    });

    test('a non-resumed attach always enters', async () => {
        const { fake } = setup('presence:not-resumed');
        fake.transition('attached');
        fake.transition('attaching');
        fake.transition('attached');
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(2);
    });

    test('a user enter() that failed is also restored on a resumed attach', async () => {
        const { fake, echoChannel } = setup('presence:user-enter');
        fake.transition('attached');
        await settle();
        fake.presence.enter.mockImplementationOnce(() => Promise.reject(ablyError('enter failed', 91004)));
        const cb = jest.fn();
        echoChannel.enter({ name: 'u' }, cb);
        await settle();
        expect(cb.mock.calls[0][0]).toMatchObject({ code: 91004 });
        resume(fake);
        await settle();
        expect(fake.presence.enter).toHaveBeenCalledTimes(3);
    });
});
