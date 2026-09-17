import { describe, expect, it, vi } from 'vitest';

describe('actor channel', () => {
  it('opens a fresh named tab port for the requested tab', async () => {
    const connect = vi.fn(() => ({ name: 'motion-actor' } as chrome.runtime.Port));
    vi.stubGlobal('chrome', { tabs: { connect } });
    const { ACTOR_PORT_NAME, connectActorPort } = await import('./actorChannel');

    const port = connectActorPort(7);

    expect(connect).toHaveBeenCalledWith(7, { name: ACTOR_PORT_NAME });
    expect(port.name).toBe(ACTOR_PORT_NAME);
    vi.unstubAllGlobals();
  });
});
