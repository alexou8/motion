import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDatabase, deleteDatabase, putRecord, getAllRecords } from './db';
import { Repository } from './repository';
import { DB_VERSION, MIGRATIONS, STORE } from './schema';
import { courseSchema } from '../domain';

const NAME = 'motion-test';

async function fresh(): Promise<IDBDatabase> {
  await deleteDatabase(NAME);
  return openDatabase(NAME);
}

function course(overrides: Record<string, unknown> = {}) {
  return courseSchema.parse({
    id: 'd2l:12345',
    platformId: 'd2l',
    name: 'Database II',
    code: 'CP363',
    term: 'Fall 2025',
    homeUrl: 'https://mylearningspace.wlu.ca/d2l/home/12345',
    externalId: '12345',
    lastVerifiedAt: '2026-03-02T12:00:00.000Z',
    archived: false,
    ...overrides,
  });
}

describe('schema definition', () => {
  it('keeps DB_VERSION in step with the migration list', () => {
    expect(MIGRATIONS.length).toBe(DB_VERSION);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
  });
});

describe('database creation', () => {
  it('creates every declared store with its indexes', async () => {
    const db = await fresh();
    for (const store of Object.values(STORE)) {
      expect(db.objectStoreNames.contains(store)).toBe(true);
    }
    const transaction = db.transaction(STORE.tasks, 'readonly');
    const tasks = transaction.objectStore(STORE.tasks);
    expect([...tasks.indexNames]).toEqual(expect.arrayContaining(['byCourse', 'byDue']));
    db.close();
  });

  it('is idempotent when reopened at the same version', async () => {
    const first = await fresh();
    first.close();
    const second = await openDatabase(NAME);
    expect(second.version).toBe(DB_VERSION);
    expect(second.objectStoreNames.contains(STORE.courses)).toBe(true);
    second.close();
  });
});

describe('migration replay from an older version', () => {
  it('upgrades a version-0 database by applying every step', async () => {
    await deleteDatabase(NAME);
    // Simulate a browser that has never seen Motion: opening at the current
    // version must replay all steps, not just the newest one.
    const db = await openDatabase(NAME, DB_VERSION);
    for (const store of Object.values(STORE)) {
      expect(db.objectStoreNames.contains(store)).toBe(true);
    }
    db.close();
  });

  it('preserves existing rows across a reopen', async () => {
    const db = await fresh();
    await putRecord(db, STORE.courses, course());
    db.close();

    const reopened = await openDatabase(NAME);
    const rows = await getAllRecords(reopened, STORE.courses);
    expect(rows).toHaveLength(1);
    reopened.close();
  });
});

describe('Repository', () => {
  let db: IDBDatabase;
  beforeEach(async () => {
    db = await fresh();
  });

  it('round-trips a validated record', async () => {
    const repo = new Repository(db, STORE.courses, courseSchema);
    await repo.put(course());
    const found = await repo.get('d2l:12345');
    expect(found?.code).toBe('CP363');
  });

  it('refuses to write a record that fails validation', async () => {
    const repo = new Repository(db, STORE.courses, courseSchema);
    // Built raw rather than via the helper, which would validate it first.
    const invalid = { ...course(), name: '' } as never;
    await expect(repo.put(invalid)).rejects.toThrow();
  });

  it('returns null rather than throwing for a corrupted single row', async () => {
    // Write past the repository to plant a row an older build might have left.
    await putRecord(db, STORE.courses, { id: 'broken', platformId: 'd2l' });
    const repo = new Repository(db, STORE.courses, courseSchema);
    expect(await repo.get('broken')).toBeNull();
  });

  it('quarantines corrupted rows and still returns the good ones', async () => {
    await putRecord(db, STORE.courses, course());
    await putRecord(db, STORE.courses, { id: 'broken', platformId: 'd2l' });

    const repo = new Repository(db, STORE.courses, courseSchema);
    const result = await repo.all();

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.id).toBe('d2l:12345');
    expect(result.corrupted).toHaveLength(1);
    expect(result.corrupted[0]?.key).toBe('broken');
  });

  it('reads through an index', async () => {
    const repo = new Repository(db, STORE.courses, courseSchema);
    await repo.putMany([course(), course({ id: 'd2l:222', externalId: '222', name: 'Biology' })]);
    const result = await repo.byIndex('byPlatform', 'd2l');
    expect(result.records).toHaveLength(2);
  });

  it('deletes a record', async () => {
    const repo = new Repository(db, STORE.courses, courseSchema);
    await repo.put(course());
    await repo.delete('d2l:12345');
    expect(await repo.get('d2l:12345')).toBeNull();
  });
});

describe('local data deletion', () => {
  it('removes the database entirely, so "delete my data" is real', async () => {
    const db = await fresh();
    await putRecord(db, STORE.courses, course());
    db.close();
    await deleteDatabase(NAME);

    const reopened = await openDatabase(NAME);
    const rows = await getAllRecords(reopened, STORE.courses);
    expect(rows).toHaveLength(0);
    reopened.close();
  });
});

describe('schema guards', () => {
  it('rejects a course row with an invalid URL', () => {
    expect(() => course({ homeUrl: 'not-a-url' })).toThrow();
  });

  it('accepts a course with no optional metadata', () => {
    const minimal = courseSchema.parse({
      id: 'd2l:1',
      platformId: 'd2l',
      name: 'Untitled course',
      lastVerifiedAt: '2026-03-02T12:00:00.000Z',
    });
    expect(minimal.archived).toBe(false);
    expect(z.string().safeParse(minimal.code).success).toBe(false);
  });
});
