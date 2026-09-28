/**
 * A short-lived, non-interactive visual explanation of an already-authorized
 * actor action. This module receives a resolved Element only; it cannot find
 * elements, run actions, or create a new page-command channel.
 */
import type { ActRequest, ElementDescriptor } from '@/core/actor/contracts';

const ROOT_ID = 'motion-presence-root';
const LIVE_ID = 'motion-presence-live';
const PREVIEW_LIMIT = 72;
const CLEANUP_DELAY_MS = 480;
const MAX_PAINT_WAIT_MS = 160;

export interface MotionPresence {
  show(target: Element, request: ActRequest, descriptor: ElementDescriptor, signal?: AbortSignal): Promise<void>;
  finish(immediately?: boolean): void;
}

function compact(value: string, limit = PREVIEW_LIMIT): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function isSensitive(descriptor: ElementDescriptor): boolean {
  return descriptor.type === 'password' || /password|passcode|secret|token|api.?key|credit.?card|card.?number|social.?security/i.test(
    `${descriptor.label} ${descriptor.name ?? ''}`,
  );
}

/** Kept pure and bounded so a fill value is never stored for the animation. */
export function presenceCopy(request: ActRequest, descriptor: ElementDescriptor): string {
  const target = compact(descriptor.label || 'this control', 56);
  switch (request.type) {
    case 'click': return `Clicking ${target}`;
    case 'scrollTo': return `Scrolling to ${target}`;
    case 'focus': return `Focusing ${target}`;
    case 'select': return `Choosing ${target}`;
    case 'toggle': return `${request.checked ? 'Selecting' : 'Clearing'} ${target}`;
    case 'fill': {
      const preview = isSensitive(descriptor) ? '••••••' : compact(request.value);
      return `Typing: ${preview}`;
    }
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function ensureRoot(): { host: HTMLElement; shadow: ShadowRoot; live: HTMLElement } {
  const existing = document.getElementById(ROOT_ID);
  const existingLive = document.getElementById(LIVE_ID);
  if (existing?.shadowRoot && existingLive) {
    return { host: existing, shadow: existing.shadowRoot, live: existingLive };
  }
  existing?.remove();
  existingLive?.remove();

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;contain:layout style paint;';
  const live = document.createElement('div');
  live.id = LIVE_ID;
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.setAttribute('role', 'status');
  live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;';
  const shadow = host.attachShadow({ mode: 'closed' });
  styleFor(shadow);
  document.documentElement.appendChild(host);
  // An unslotted light-DOM child of a shadow host is not reliably exposed in
  // the accessibility tree. Keep the visual layer hidden and announce from a
  // document sibling instead.
  document.documentElement.appendChild(live);
  return { host, shadow, live };
}

function styleFor(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .motion-presence { position: fixed; inset: 0; pointer-events: none; color: #3d241b; font-family: system-ui, sans-serif; }
    .motion-presence__halo { position: fixed; border: 3px solid #a54f33; border-radius: 5px; box-sizing: border-box; box-shadow: 0 0 0 3px rgb(165 79 51 / 20%); }
    .motion-presence__pointer { position: fixed; width: 0; height: 0; border-top: 11px solid transparent; border-bottom: 6px solid transparent; border-left: 16px solid #a54f33; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 35%)); }
    .motion-presence__label { position: fixed; max-width: min(18rem, calc(100vw - 2rem)); padding: .35rem .5rem; border: 1px solid #6f3929; border-radius: .25rem; background: #fffaf2; color: #3d241b; font-size: .8125rem; font-weight: 600; line-height: 1.25; box-shadow: 0 2px 7px rgb(0 0 0 / 20%); }
    .motion-presence__pulse { position: fixed; width: 20px; height: 20px; border: 2px solid #a54f33; border-radius: 50%; transform: translate(-50%, -50%); }
    .motion-presence--animated .motion-presence__pointer { animation: motion-presence-in 140ms ease-out both; }
    .motion-presence--animated .motion-presence__pulse { animation: motion-presence-pulse 180ms ease-out both; }
    @keyframes motion-presence-in { from { opacity: 0; transform: translate(-7px, 7px); } to { opacity: 1; transform: translate(0, 0); } }
    @keyframes motion-presence-pulse { from { opacity: .9; transform: translate(-50%, -50%) scale(.45); } to { opacity: 0; transform: translate(-50%, -50%) scale(1.5); } }
    @media (prefers-reduced-motion: reduce) { .motion-presence__pointer, .motion-presence__pulse { animation: none !important; } .motion-presence__pulse { opacity: 0; } }
  `;
  shadow.appendChild(style);
}

function nextPaint(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const firstFrame: { value: number | undefined } = { value: undefined };
    let secondFrame: number | undefined;
    const timeout: { value: number | undefined } = { value: undefined };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout.value !== undefined) window.clearTimeout(timeout.value);
      if (firstFrame.value !== undefined) window.cancelAnimationFrame?.(firstFrame.value);
      if (secondFrame !== undefined) window.cancelAnimationFrame?.(secondFrame);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    if (signal?.aborted || typeof window.requestAnimationFrame !== 'function') {
      finish();
      return;
    }

    timeout.value = window.setTimeout(finish, MAX_PAINT_WAIT_MS);
    signal?.addEventListener('abort', finish, { once: true });
    firstFrame.value = window.requestAnimationFrame(() => {
      if (signal?.aborted) {
        finish();
        return;
      }
      secondFrame = window.requestAnimationFrame(finish);
    });
  });
}

/** Creates the dormant-on-load presence layer. */
export function createMotionPresence(): MotionPresence {
  let host: HTMLElement | null = null;
  let cleanupTimer: number | undefined;

  const remove = () => {
    if (cleanupTimer !== undefined) window.clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
    host?.remove();
    document.getElementById(LIVE_ID)?.remove();
    host = null;
  };

  const finish = (immediately = false) => {
    if (!host) return;
    if (immediately) {
      remove();
      return;
    }
    if (cleanupTimer !== undefined) window.clearTimeout(cleanupTimer);
    cleanupTimer = window.setTimeout(remove, CLEANUP_DELAY_MS);
  };

  window.addEventListener('pagehide', () => finish(true), { once: false });

  return {
    async show(target, request, descriptor, signal) {
      finish(true);
      if (signal?.aborted) return;
      const root = ensureRoot();
      host = root.host;
      const reduced = prefersReducedMotion();
      const rect = target.getBoundingClientRect();
      const left = Math.max(0, Math.min(window.innerWidth - 1, rect.left));
      const top = Math.max(0, Math.min(window.innerHeight - 1, rect.top));
      const width = Math.max(2, Math.min(window.innerWidth - left, rect.width));
      const height = Math.max(2, Math.min(window.innerHeight - top, rect.height));
      const x = left + width / 2;
      const y = top + height / 2;

      const container = createElement('div', reduced ? 'motion-presence' : 'motion-presence motion-presence--animated');
      container.setAttribute('aria-hidden', 'true');
      const halo = createElement('div', 'motion-presence__halo');
      halo.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
      const pointer = createElement('div', 'motion-presence__pointer');
      pointer.style.cssText = `left:${Math.min(window.innerWidth - 18, x + 7)}px;top:${Math.max(0, y - 10)}px;`;
      const label = createElement('div', 'motion-presence__label');
      label.textContent = `Motion · ${presenceCopy(request, descriptor)}`;
      label.style.cssText = `left:${Math.min(window.innerWidth - 296, Math.max(8, x + 18))}px;top:${Math.min(window.innerHeight - 38, Math.max(8, y + 14))}px;`;
      container.append(halo, pointer, label);
      if (request.type === 'click') {
        const pulse = createElement('div', 'motion-presence__pulse');
        pulse.style.cssText = `left:${x}px;top:${y}px;`;
        container.appendChild(pulse);
      }
      root.shadow.appendChild(container);
      root.live.textContent = `Motion: ${presenceCopy(request, descriptor)}`;
      await nextPaint(signal);
    },
    finish,
  };
}
