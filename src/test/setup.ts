import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

/**
 * jsdom has no Web Locks, and the worker relies on them (src/platform/locks.ts).
 * Tests get a minimal same-process stand-in: requests for one name run one at
 * a time, in the order made — which is the property the code depends on.
 */
if (!(navigator as { locks?: unknown }).locks) {
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request(name: string, callback: () => Promise<unknown>): Promise<unknown> {
        const run = (tails.get(name) ?? Promise.resolve()).then(() => callback());
        tails.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    },
  });
}
