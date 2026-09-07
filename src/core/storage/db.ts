import { DB_NAME, DB_VERSION, MIGRATIONS, type StoreName } from './schema';

/**
 * Thin promise wrapper over IndexedDB.
 *
 * Deliberately not a library: the surface Motion needs is small, and an
 * extension pays for every dependency in review scrutiny and bundle size.
 */

export function openDatabase(
  name = DB_NAME,
  version = DB_VERSION,
  indexedDBImpl: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(name, version);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) {
        reject(new Error('Upgrade transaction unavailable'));
        return;
      }
      const from = event.oldVersion;
      // Replay only the steps this database has not seen.
      for (const migration of MIGRATIONS) {
        if (migration.version > from) migration.apply(db, transaction);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab requested a newer version: close so it is not blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open database'));
    request.onblocked = () =>
      reject(new Error('Database upgrade blocked by another open connection'));
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function withStore<T>(
  db: IDBDatabase,
  store: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | IDBRequest[] | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    let result: unknown;
    const requests = run(transaction.objectStore(store));
    if (requests && !Array.isArray(requests)) {
      requests.onsuccess = () => {
        result = requests.result;
      };
    }
    transaction.oncomplete = () => resolve(result as T);
    transaction.onerror = () => reject(transaction.error ?? new Error('Transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
  });
}

export async function getRecord<T>(
  db: IDBDatabase,
  store: StoreName,
  key: IDBValidKey,
): Promise<T | undefined> {
  const transaction = db.transaction(store, 'readonly');
  return promisify<T | undefined>(
    transaction.objectStore(store).get(key) as IDBRequest<T | undefined>,
  );
}

export async function getAllRecords<T>(
  db: IDBDatabase,
  store: StoreName,
  query?: IDBKeyRange,
): Promise<T[]> {
  const transaction = db.transaction(store, 'readonly');
  return promisify<T[]>(transaction.objectStore(store).getAll(query) as IDBRequest<T[]>);
}

export async function getAllByIndex<T>(
  db: IDBDatabase,
  store: StoreName,
  index: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const transaction = db.transaction(store, 'readonly');
  return promisify<T[]>(
    transaction.objectStore(store).index(index).getAll(query) as IDBRequest<T[]>,
  );
}

export async function putRecord<T>(db: IDBDatabase, store: StoreName, value: T): Promise<void> {
  await withStore(db, store, 'readwrite', (s) => s.put(value as unknown as Record<string, unknown>));
}

export async function putAll<T>(db: IDBDatabase, store: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return;
  await withStore(db, store, 'readwrite', (s) => {
    for (const value of values) s.put(value as unknown as Record<string, unknown>);
  });
}

export async function deleteRecord(
  db: IDBDatabase,
  store: StoreName,
  key: IDBValidKey,
): Promise<void> {
  await withStore(db, store, 'readwrite', (s) => s.delete(key));
}

export async function clearStore(db: IDBDatabase, store: StoreName): Promise<void> {
  await withStore(db, store, 'readwrite', (s) => s.clear());
}

export function deleteDatabase(name = DB_NAME, indexedDBImpl: IDBFactory = indexedDB): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete database'));
    request.onblocked = () => resolve();
  });
}
