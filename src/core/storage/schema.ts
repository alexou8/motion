/**
 * IndexedDB schema for Motion's local-first store.
 *
 * Migrations are expressed as an ordered list of steps rather than a single
 * `onupgradeneeded` switch, so upgrading from any older version replays only
 * the steps it missed. Each step must be idempotent-safe on a partially
 * upgraded database: an interrupted upgrade is a real scenario in a browser.
 */

export const DB_NAME = 'motion';

/** Bump when adding a migration step. Must equal `MIGRATIONS.length`. */
export const DB_VERSION = 2;

export const STORE = {
  courses: 'courses',
  tasks: 'tasks',
  notes: 'notes',
  checklists: 'checklists',
  workflows: 'workflows',
  approvals: 'approvals',
  auditEvents: 'auditEvents',
  meta: 'meta',
  sessions: 'sessions',
  courseLinks: 'courseLinks',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

export interface MigrationStep {
  /** The version this step upgrades the database *to*. */
  version: number;
  describe: string;
  apply(db: IDBDatabase, transaction: IDBTransaction): void;
}

function ensureStore(
  db: IDBDatabase,
  name: string,
  options: IDBObjectStoreParameters,
  transaction: IDBTransaction,
): IDBObjectStore {
  return db.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : db.createObjectStore(name, options);
}

function ensureIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string | string[],
  options?: IDBIndexParameters,
): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    describe: 'Initial schema: courses, tasks, notes, checklists, workflows, approvals, audit.',
    apply(db, transaction) {
      const courses = ensureStore(db, STORE.courses, { keyPath: 'id' }, transaction);
      ensureIndex(courses, 'byPlatform', 'platformId');

      const tasks = ensureStore(db, STORE.tasks, { keyPath: 'id' }, transaction);
      ensureIndex(tasks, 'byCourse', 'courseId');
      // Nested key path: lets the dashboard read upcoming work without a scan.
      ensureIndex(tasks, 'byDue', 'due.iso');

      const notes = ensureStore(db, STORE.notes, { keyPath: 'id' }, transaction);
      ensureIndex(notes, 'byCourse', 'courseId');
      ensureIndex(notes, 'byTask', 'taskId');

      const checklists = ensureStore(db, STORE.checklists, { keyPath: 'id' }, transaction);
      ensureIndex(checklists, 'byTask', 'taskId');

      const workflows = ensureStore(db, STORE.workflows, { keyPath: 'id' }, transaction);
      ensureIndex(workflows, 'byStatus', 'status');
      ensureIndex(workflows, 'byUpdatedAt', 'updatedAt');

      const approvals = ensureStore(db, STORE.approvals, { keyPath: 'id' }, transaction);
      ensureIndex(approvals, 'byWorkflow', 'workflowId');
      ensureIndex(approvals, 'byStatus', 'status');

      const audit = ensureStore(
        db,
        STORE.auditEvents,
        { keyPath: 'seq', autoIncrement: true },
        transaction,
      );
      ensureIndex(audit, 'byAt', 'at');
      ensureIndex(audit, 'byWorkflow', 'workflowId');

      ensureStore(db, STORE.meta, { keyPath: 'key' }, transaction);
    },
  },
  {
    version: 2,
    describe: 'AgentSession + course graph: sessions, courseLinks stores.',
    apply(db, transaction) {
      const sessions = ensureStore(db, STORE.sessions, { keyPath: 'id' }, transaction);
      ensureIndex(sessions, 'byStatus', 'status');
      ensureIndex(sessions, 'byUpdatedAt', 'updatedAt');
      ensureIndex(sessions, 'byCourse', 'courseId');

      const courseLinks = ensureStore(db, STORE.courseLinks, { keyPath: 'id' }, transaction);
      ensureIndex(courseLinks, 'byCourse', 'courseId');
      ensureIndex(courseLinks, 'byTask', 'taskId');
    },
  },
];

if (MIGRATIONS.length !== DB_VERSION) {
  throw new Error(
    `DB_VERSION (${DB_VERSION}) must equal the number of migrations (${MIGRATIONS.length}).`,
  );
}
