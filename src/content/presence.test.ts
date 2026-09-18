import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActRequest, ElementDescriptor } from '@/core/actor/contracts';
import { createMotionPresence, presenceCopy } from './presence';

const descriptor: ElementDescriptor = {
  handle: 'e1', role: 'textbox', tag: 'input', type: 'text', label: 'Discussion response', name: 'response', disabled: false,
};

describe('MotionPresence', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  });

  afterEach(() => {
    document.getElementById('motion-presence-root')?.remove();
    document.getElementById('motion-presence-live')?.remove();
    vi.unstubAllGlobals();
  });

  it('uses a bounded preview and masks values for sensitive fields', () => {
    const fill: ActRequest = { type: 'fill', snapshotId: 'snap', handle: 'e1', value: 'A'.repeat(100) };
    expect(presenceCopy(fill, descriptor)).toBe(`Typing: ${'A'.repeat(71)}…`);
    expect(presenceCopy(fill, { ...descriptor, type: 'password', label: 'Password' })).toBe('Typing: ••••••');
    expect(presenceCopy({ type: 'click', snapshotId: 'snap', handle: 'e1' }, descriptor)).toBe('Clicking Discussion response');
  });

  it('is dormant until an action, cannot receive pointer events, and cleans itself up', async () => {
    const target = document.createElement('button');
    target.textContent = 'Save draft';
    target.getBoundingClientRect = () => new DOMRect(20, 30, 100, 30);
    document.body.appendChild(target);
    const presence = createMotionPresence();
    expect(document.getElementById('motion-presence-root')).toBeNull();

    await presence.show(target, { type: 'click', snapshotId: 'snap', handle: 'e1' }, { ...descriptor, role: 'button', tag: 'button', label: 'Save draft' });
    const host = document.getElementById('motion-presence-root');
    expect(host).toHaveStyle({ pointerEvents: 'none' });
    expect(host?.shadowRoot).toBeNull(); // Closed shadow isolates LMS styling.
    expect(host).toHaveAttribute('aria-hidden', 'true');
    const live = document.getElementById('motion-presence-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live?.parentElement).toBe(document.documentElement);

    presence.finish();
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    expect(document.getElementById('motion-presence-root')).toBeNull();
    expect(document.getElementById('motion-presence-live')).toBeNull();
  });

  it('does not wait indefinitely when animation frames are suspended or unavailable', async () => {
    vi.useFakeTimers();
    const target = document.createElement('button');
    document.body.appendChild(target);
    const presence = createMotionPresence();

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    const suspended = presence.show(target, { type: 'click', snapshotId: 'snap', handle: 'e1' }, { ...descriptor, role: 'button', tag: 'button' });
    await vi.advanceTimersByTimeAsync(200);
    await expect(suspended).resolves.toBeUndefined();

    presence.finish(true);
    vi.stubGlobal('requestAnimationFrame', undefined);
    await expect(presence.show(target, { type: 'click', snapshotId: 'snap', handle: 'e1' }, { ...descriptor, role: 'button', tag: 'button' })).resolves.toBeUndefined();
    presence.finish(true);
    vi.useRealTimers();
  });

  it('removes both layers immediately on navigation and keeps reduced-motion visuals non-animated', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const target = document.createElement('button');
    document.body.appendChild(target);
    const presence = createMotionPresence();

    await presence.show(target, { type: 'focus', snapshotId: 'snap', handle: 'e1' }, { ...descriptor, role: 'button', tag: 'button' });
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(document.getElementById('motion-presence-root')).not.toBeNull();

    window.dispatchEvent(new Event('pagehide'));
    expect(document.getElementById('motion-presence-root')).toBeNull();
    expect(document.getElementById('motion-presence-live')).toBeNull();
  });
});
