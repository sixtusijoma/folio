import type { Io } from '@/lib/types';

const DB = 'folio';
const STORE = 'files';
const urls = new Map<string, string>();

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        db.onclose = () => {
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        opening = null;
        reject(request.error ?? new Error('Could not open the library database.'));
      };
    });
  }
  return opening;
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * `request.onsuccess` runs before the transaction commits. Resolving there lets the next
 * full-library write read a stale snapshot, and a navigation can abort the commit.
 * Writes wait for `transaction.oncomplete`. One connection keeps those transactions ordered.
 */
function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, durable: boolean): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        const tx = db.transaction(STORE, mode);
        const fail = () => {
          if (settled) return;
          settled = true;
          reject(tx.error ?? new Error('The library database write did not finish.'));
        };
        tx.onabort = fail;
        tx.onerror = fail;
        const request = run(tx.objectStore(STORE));
        request.onerror = fail;
        if (!durable) {
          request.onsuccess = () => {
            if (settled) return;
            settled = true;
            resolve(request.result);
          };
          return;
        }
        let result = undefined as T;
        request.onsuccess = () => {
          result = request.result;
        };
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
      }),
  );
}

export function createIo(): Io {
  return {
    async readText(path) {
      const value = await withStore<ArrayBuffer | undefined>('readonly', (store) => store.get(path), false);
      return value ? new TextDecoder().decode(value) : null;
    },
    async writeText(path, text) {
      const copy = bytesBuffer(new TextEncoder().encode(text));
      await withStore('readwrite', (store) => store.put(copy, path), true);
      urls.delete(path);
    },
    async mutateText(path, update) {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const tx = db.transaction(STORE, 'readwrite');
        const fail = () => {
          if (settled) return;
          settled = true;
          reject(tx.error ?? new Error('The library database write did not finish.'));
        };
        tx.onabort = fail;
        tx.onerror = fail;
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const store = tx.objectStore(STORE);
        const request = store.get(path);
        request.onerror = fail;
        request.onsuccess = () => {
          try {
            const current = request.result ? new TextDecoder().decode(request.result as ArrayBuffer) : null;
            const next = update(current);
            store.put(bytesBuffer(new TextEncoder().encode(next)), path);
          } catch (error) {
            try {
              tx.abort();
            } catch {
              // The transaction may already be finishing.
            }
            if (!settled) {
              settled = true;
              reject(error instanceof Error ? error : new Error('The library database write did not finish.'));
            }
          }
        };
      });
      urls.delete(path);
    },
    async readBytes(path) {
      const value = await withStore<ArrayBuffer | undefined>('readonly', (store) => store.get(path), false);
      return value ? new Uint8Array(value) : null;
    },
    async writeBytes(path, bytes) {
      const copy = bytesBuffer(bytes);
      await withStore('readwrite', (store) => store.put(copy, path), true);
      urls.delete(path);
    },
    async exists(path) {
      const value = await withStore<ArrayBuffer | undefined>('readonly', (store) => store.get(path), false);
      return value != null;
    },
    async remove(path) {
      await withStore('readwrite', (store) => store.delete(path), true);
      const url = urls.get(path);
      if (url) URL.revokeObjectURL(url);
      urls.delete(path);
    },
    async uri(path) {
      const cached = urls.get(path);
      if (cached) return cached;
      const value = await withStore<ArrayBuffer | undefined>('readonly', (store) => store.get(path), false);
      if (!value) return null;
      const url = URL.createObjectURL(new Blob([value]));
      urls.set(path, url);
      return url;
    },
  };
}
