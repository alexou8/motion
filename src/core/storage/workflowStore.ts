import { workflowSchema, type Workflow } from '../workflows/types';
import { STORE } from './schema';

/**
 * Workflow persistence with a read-modify-write primitive that commits inside a
 * single IndexedDB transaction.
 *
 * This is the difference between a concurrency control and a comment: several
 * triggers (an inbound message, an alarm, startup recovery) can observe the
 * same workflow simultaneously, and a service worker can die between any two
 * statements. Reading a workflow, deciding, and writing it back as separate
 * awaits would interleave.
 */
export interface WorkflowStore {
  create(workflow: Workflow): Promise<void>;
  get(id: string): Promise<Workflow | null>;
  list(): Promise<Workflow[]>;
  /**
   * Atomically apply `mutate` to the stored workflow.
   *
   * The mutator runs *inside* the transaction and must be synchronous and
   * side-effect free — awaiting anything would let the transaction auto-close.
   * Returning `null` aborts the write and is how a failed compare-and-swap
   * (someone else holds the lease) is expressed.
   */
  update(id: string, mutate: (current: Workflow) => Workflow | null): Promise<Workflow | null>;
}

export class IndexedDbWorkflowStore implements WorkflowStore {
  constructor(private readonly db: IDBDatabase) {}

  create(workflow: Workflow): Promise<void> {
    const validated = workflowSchema.parse(workflow);
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE.workflows, 'readwrite');
      transaction.objectStore(STORE.workflows).add(validated);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('create failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('create aborted'));
    });
  }

  get(id: string): Promise<Workflow | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE.workflows, 'readonly');
      const request = transaction.objectStore(STORE.workflows).get(id);
      request.onsuccess = () => {
        const parsed = workflowSchema.safeParse(request.result);
        resolve(parsed.success ? parsed.data : null);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('get failed'));
    });
  }

  list(): Promise<Workflow[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE.workflows, 'readonly');
      const request = transaction.objectStore(STORE.workflows).getAll();
      request.onsuccess = () => {
        // A corrupted workflow is skipped rather than throwing, so one bad row
        // cannot stop every other workflow from being recovered.
        const rows: Workflow[] = [];
        for (const raw of request.result ?? []) {
          const parsed = workflowSchema.safeParse(raw);
          if (parsed.success) rows.push(parsed.data);
        }
        resolve(rows);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('list failed'));
    });
  }

  update(id: string, mutate: (current: Workflow) => Workflow | null): Promise<Workflow | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE.workflows, 'readwrite');
      const store = transaction.objectStore(STORE.workflows);
      const read = store.get(id);
      let outcome: Workflow | null = null;

      read.onsuccess = () => {
        const parsed = workflowSchema.safeParse(read.result);
        if (!parsed.success) {
          // Nothing to update; let the transaction complete with a null result.
          return;
        }
        let next: Workflow | null;
        try {
          next = mutate(parsed.data);
        } catch (error) {
          transaction.abort();
          reject(error);
          return;
        }
        if (next === null) return; // compare-and-swap declined
        const validated = workflowSchema.parse(next);
        store.put(validated);
        outcome = validated;
      };

      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(transaction.error ?? new Error('update failed'));
      transaction.onabort = () => {
        if (outcome === null) resolve(null);
      };
    });
  }
}

/** In-memory store for tests and for exercising the engine without a browser. */
export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly rows = new Map<string, Workflow>();

  async create(workflow: Workflow): Promise<void> {
    const validated = workflowSchema.parse(workflow);
    if (this.rows.has(validated.id)) throw new Error(`Workflow ${validated.id} already exists`);
    this.rows.set(validated.id, validated);
  }

  async get(id: string): Promise<Workflow | null> {
    const row = this.rows.get(id);
    return row ? workflowSchema.parse(structuredClone(row)) : null;
  }

  async list(): Promise<Workflow[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }

  async update(
    id: string,
    mutate: (current: Workflow) => Workflow | null,
  ): Promise<Workflow | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = mutate(structuredClone(row));
    if (next === null) return null;
    const validated = workflowSchema.parse(next);
    this.rows.set(id, validated);
    return structuredClone(validated);
  }
}
