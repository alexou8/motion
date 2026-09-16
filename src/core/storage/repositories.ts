import { agentSessionSchema } from '../session';
import { courseLinkSchema } from '../graph';
import { Repository } from './repository';
import { STORE } from './schema';

/** Typed repository over the `sessions` store, validating on every read/write. */
export function sessionRepository(db: IDBDatabase) {
  return new Repository(db, STORE.sessions, agentSessionSchema);
}

/** Typed repository over the `courseLinks` store, validating on every read/write. */
export function courseLinkRepository(db: IDBDatabase) {
  return new Repository(db, STORE.courseLinks, courseLinkSchema);
}
