/**
 * Mutual exclusion that the browser, not Motion, holds.
 *
 * Two presses of a button reach the worker as two messages handled at once,
 * and "look for an existing workflow, then create one" is a read-then-write
 * that both can pass. An in-memory flag would be module state that dies with
 * the worker (docs/THREAT_MODEL.md T7). A Web Lock is held by the browser and
 * released if the worker is killed, so it neither leaks nor strands work.
 */
export async function withLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  return (await navigator.locks.request(name, run)) as T;
}
