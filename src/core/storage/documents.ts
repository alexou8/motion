import { indexedDocumentSchema, DOCUMENT_LIBRARY_LIMIT, type IndexedDocument } from '../documents/library';
import { STORE } from './schema';

/** The count and write share a transaction, so simultaneous imports respect the cap. */
export function saveIndexedDocument(db: IDBDatabase, raw: IndexedDocument): Promise<void> {
  const document = indexedDocumentSchema.parse(raw);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.documents, 'readwrite');
    const store = transaction.objectStore(STORE.documents);
    let reason = 'Motion could not save this document. Try again.';
    const current = store.get(document.id);
    current.onsuccess = () => {
      const count = store.count();
      count.onsuccess = () => {
        if (!current.result && count.result >= DOCUMENT_LIBRARY_LIMIT) {
          reason = 'Your library has reached 100 documents. Remove a document before importing another.';
          transaction.abort();
          return;
        }
        store.put(document);
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(reason));
    transaction.onabort = () => reject(new Error(reason));
  });
}

/** Even an older or edited database cannot turn a library request into an unbounded read. */
export function readIndexedDocuments(db: IDBDatabase): Promise<IndexedDocument[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.documents, 'readonly');
    const request = transaction.objectStore(STORE.documents).getAll(undefined, DOCUMENT_LIBRARY_LIMIT);
    request.onsuccess = () => resolve(request.result.flatMap((row: unknown) => {
      const parsed = indexedDocumentSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }));
    request.onerror = () => reject(new Error('Motion could not read your document library. Try again.'));
  });
}
