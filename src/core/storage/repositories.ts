import { agentSessionSchema } from '../session';
import type { AgentSession } from '../session';
import { courseLinkSchema } from '../graph';
import { STORE } from './schema';
import { Repository } from './repository';

/** Typed repository over the `sessions` store, validating on every read/write. */
export function sessionRepository(db: IDBDatabase) {
  return new Repository(db, STORE.sessions, agentSessionSchema);
}

/**
 * Atomically update one AgentSession.
 *
 * The read, mutation and write intentionally share one IndexedDB transaction.
 * IndexedDB serializes concurrent readwrite transactions for this store, so a
 * second worker observes the first worker's revision rather than overwriting
 * it with a stale read-modify-write result.
 */
export function updateSession(
  db: IDBDatabase,
  id: string,
  mutator: (session: AgentSession) => AgentSession | null,
): Promise<AgentSession | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.sessions, 'readwrite');
    const store = transaction.objectStore(STORE.sessions);
    let intentionalAbort = false;
    let result: AgentSession | null = null;
    let failure: unknown = null;

    const request = store.get(id);
    request.onerror = () => {
      failure = request.error ?? new Error('Failed to read session.');
      transaction.abort();
    };
    request.onsuccess = () => {
      const parsed = agentSessionSchema.safeParse(request.result);
      if (!parsed.success) {
        intentionalAbort = true;
        transaction.abort();
        return;
      }

      let next: AgentSession | null;
      try {
        next = mutator(parsed.data);
      } catch (error) {
        failure = error;
        transaction.abort();
        return;
      }
      if (next === null) {
        intentionalAbort = true;
        transaction.abort();
        return;
      }

      try {
        result = agentSessionSchema.parse({
          ...next,
          revision: parsed.data.revision + 1,
        });
        store.put(result);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => {
      if (failure) reject(failure);
      else reject(transaction.error ?? new Error('Session transaction failed.'));
    };
    transaction.onabort = () => {
      if (failure) reject(failure);
      else if (intentionalAbort) resolve(null);
      else reject(transaction.error ?? new Error('Session transaction aborted.'));
    };
  });
}

/** Typed repository over the `courseLinks` store, validating on every read/write. */
export function courseLinkRepository(db: IDBDatabase) {
  return new Repository(db, STORE.courseLinks, courseLinkSchema);
}
