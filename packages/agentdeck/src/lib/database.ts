export type DatabaseStoreOptions = {
  name: string;
  version: number;
  storeName: string;
  keyPath?: string;
};

/** One typed object store, with ordered operations and transaction-level completion. */
export const createDatabaseStore = <T>({ name, version, storeName, keyPath }: DatabaseStoreOptions) => {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`Opening ${name} timed out`)), 1000);
      try {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName, keyPath ? { keyPath } : undefined);
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (settled) {
            db.close();
            return;
          }
          settled = true;
          clearTimeout(timer);
          db.onversionchange = () => {
            db.close();
            database = undefined;
          };
          resolve(db);
        };
        request.onerror = () => fail(request.error);
        request.onblocked = () => fail(new Error(`Opening ${name} is blocked`));
      } catch (error) {
        fail(error);
      }
    }).catch((error) => {
      database = undefined;
      throw error;
    });
    return database;
  };

  let pending: Promise<unknown> = Promise.resolve();
  const transaction = <R>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<R>) => {
    const result = pending.then(async () => {
      const db = await open();
      return new Promise<R>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = operation(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
    });
    pending = result.catch(() => {});
    return result;
  };

  return {
    ready: async () => {
      await open();
    },
    get: (key: IDBValidKey): Promise<T | undefined> => transaction('readonly', (store) => store.get(key)),
    getAll: (): Promise<T[]> => transaction('readonly', (store) => store.getAll()),
    set: (key: IDBValidKey, value: T) =>
      transaction('readwrite', (store) => (keyPath ? store.put(value) : store.put(value, key))),
    delete: (key: IDBValidKey) => transaction('readwrite', (store) => store.delete(key)),
    clear: () => transaction('readwrite', (store) => store.clear()),
    // The synchronous updater runs inside the read/write transaction, so another
    // writer cannot slip between the read and the write. Undefined leaves it alone.
    update: async (key: IDBValidKey, updater: (current: T | undefined) => T | undefined) => {
      let value: T | undefined;
      let updateError: unknown;
      await transaction('readwrite', (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            value = updater(request.result);
            if (value !== undefined) {
              if (keyPath) store.put(value);
              else store.put(value, key);
            }
          } catch (error) {
            updateError = error;
            store.transaction.abort();
          }
        };
        return request;
      }).catch((error) => {
        throw updateError ?? error;
      });
      return value;
    },
  };
};
