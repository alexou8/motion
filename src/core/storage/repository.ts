import type { z } from 'zod';
import { getAllByIndex, getAllRecords, getRecord, putAll, putRecord, deleteRecord } from './db';
import type { StoreName } from './schema';

export interface ReadResult<T> {
  /** Records that parsed cleanly. */
  records: T[];
  /**
   * Records that failed validation, with their keys. Motion surfaces the count
   * rather than throwing: one corrupted row from an older build must not make
   * the whole dashboard unopenable.
   */
  corrupted: { key: unknown; reason: string }[];
}

/**
 * A typed IndexedDB store that validates on the way out.
 *
 * Validating on read rather than trusting what was written is deliberate: rows
 * can predate a schema change, be written by a build with a bug, or be edited
 * by anyone with devtools access to the extension's origin. The store is not a
 * trust boundary just because Motion owns it.
 */
export class Repository<S extends z.ZodTypeAny> {
  constructor(
    private readonly db: IDBDatabase,
    private readonly store: StoreName,
    private readonly schema: S,
  ) {}

  private validate(raw: unknown[], keyOf: (row: unknown) => unknown): ReadResult<z.infer<S>> {
    const records: z.infer<S>[] = [];
    const corrupted: { key: unknown; reason: string }[] = [];
    for (const row of raw) {
      const parsed = this.schema.safeParse(row);
      if (parsed.success) records.push(parsed.data);
      else corrupted.push({ key: keyOf(row), reason: parsed.error.issues[0]?.message ?? 'invalid' });
    }
    return { records, corrupted };
  }

  async get(key: IDBValidKey): Promise<z.infer<S> | null> {
    const raw = await getRecord<unknown>(this.db, this.store, key);
    if (raw === undefined) return null;
    const parsed = this.schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async all(): Promise<ReadResult<z.infer<S>>> {
    const raw = await getAllRecords<unknown>(this.db, this.store);
    return this.validate(raw, (row) => (row as { id?: unknown })?.id);
  }

  async byIndex(index: string, query: IDBValidKey | IDBKeyRange): Promise<ReadResult<z.infer<S>>> {
    const raw = await getAllByIndex<unknown>(this.db, this.store, index, query);
    return this.validate(raw, (row) => (row as { id?: unknown })?.id);
  }

  /** Validates before writing, so a bug cannot persist an invalid shape. */
  async put(value: z.infer<S>): Promise<void> {
    await putRecord(this.db, this.store, this.schema.parse(value));
  }

  async putMany(values: z.infer<S>[]): Promise<void> {
    await putAll(
      this.db,
      this.store,
      values.map((value) => this.schema.parse(value)),
    );
  }

  async delete(key: IDBValidKey): Promise<void> {
    await deleteRecord(this.db, this.store, key);
  }
}
