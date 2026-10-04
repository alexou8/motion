import { afterEach, describe, expect, it } from 'vitest';
import { indexedDocumentSchema } from '../documents/library';
import { deleteDatabase, openDatabase, putRecord, getRecord } from './db';
import { readIndexedDocuments, saveIndexedDocument } from './documents';
import { DB_VERSION, MIGRATIONS, STORE } from './schema';

const NAME = 'motion-synthetic-documents';
const document = (id: string) => indexedDocumentSchema.parse({ id, title: 'Synthetic lecture.pdf', courseId: null,
  sourceUrl: null, sourcePageUrl: null, capturedAt: '2026-10-03T12:00:00.000Z', format: 'pdf',
  units: [{ number: 1, text: 'Synthetic lecture body.' }], totalUnits: 1, truncated: false, warnings: [] });
afterEach(async () => { await deleteDatabase(NAME); });

describe('document storage migration and limits', () => {
  it('upgrades an actual v3 schema, preserving existing records and creating only the new document store', async () => {
    await deleteDatabase(NAME);
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(NAME, 3);
      request.onupgradeneeded = () => {
        for (const migration of MIGRATIONS.filter((step) => step.version <= 3)) migration.apply(request.result, request.transaction!);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(old.objectStoreNames.contains(STORE.documents)).toBe(false);
    await putRecord(old, STORE.meta, { key: 'synthetic-preserved', value: true });
    old.close();
    const upgraded = await openDatabase(NAME);
    expect(upgraded.version).toBe(DB_VERSION);
    expect(await getRecord(upgraded, STORE.meta, 'synthetic-preserved')).toEqual({ key: 'synthetic-preserved', value: true });
    const store = upgraded.transaction(STORE.documents).objectStore(STORE.documents);
    expect([...store.indexNames]).toEqual(expect.arrayContaining(['byCourse', 'bySource', 'byCapturedAt']));
    await saveIndexedDocument(upgraded, document('synthetic-1'));
    upgraded.close();
    const reopened = await openDatabase(NAME);
    expect((await readIndexedDocuments(reopened))[0]?.id).toBe('synthetic-1');
    reopened.close();
  });
  it('atomically caps simultaneous imports and permits an existing source update at the cap', async () => {
    await deleteDatabase(NAME);
    const db = await openDatabase(NAME);
    for (let index = 0; index < 99; index++) await saveIndexedDocument(db, document(`synthetic-${index}`));
    const results = await Promise.allSettled([saveIndexedDocument(db, document('synthetic-99')), saveIndexedDocument(db, document('synthetic-100'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await saveIndexedDocument(db, { ...document('synthetic-0'), title: 'Synthetic revised lecture' });
    const rows = await readIndexedDocuments(db);
    expect(rows).toHaveLength(100);
    expect(rows.find((row) => row.id === 'synthetic-0')?.title).toBe('Synthetic revised lecture');
    db.close();
  });
  it('rejects excessive aggregate text at the persistence boundary', async () => {
    const db = await openDatabase(NAME);
    const units = Array.from({ length: 20 }, (_, index) => ({ number: index + 1, text: 'x'.repeat(12_000) }));
    expect(() => saveIndexedDocument(db, { ...document('synthetic-large'), units, totalUnits: 20 })).toThrow(/indexing limit/);
    expect(await readIndexedDocuments(db)).toEqual([]);
    db.close();
  });
});
