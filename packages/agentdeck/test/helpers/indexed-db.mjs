// In-memory IndexedDB that survives document/module reloads. Requests and transaction
// completion are asynchronous, including requests added from success handlers.
// Each database name has its own records; stores with a key path use `sessionId` (the only one in use).
export function memoryIndexedDB() {
  const databases = new Map();
  let failNext;
  const records = (name) => {
    if (!databases.has(name)) databases.set(name, new Map());
    return databases.get(name);
  };
  const database = (name) => ({
    close() {},
    transaction() {
      const values = records(name);
      let aborted = false;
      const tx = {
        abort: () => {
          aborted = true;
          queueMicrotask(() => tx.onabort());
        },
      };
      let requests = 0;
      const request = (operation) => {
        const result = {};
        requests++;
        queueMicrotask(() => {
          if (failNext === true || failNext === name) {
            failNext = undefined;
            tx.error = new Error('Storage full');
            tx.onabort();
            return;
          }
          result.result = structuredClone(operation());
          result.onsuccess?.();
          if (--requests === 0 && !aborted) queueMicrotask(() => tx.oncomplete());
        });
        return result;
      };
      tx.objectStore = () => ({
        transaction: tx,
        get: (key) => request(() => values.get(key)),
        getAll: () => request(() => [...values.values()]),
        put: (value, key) =>
          request(() => {
            values.set(key ?? value.sessionId, structuredClone(value));
            return key;
          }),
        delete: (key) =>
          request(() => {
            values.delete(key);
          }),
        clear: () => request(() => values.clear()),
      });
      return tx;
    },
  });
  return {
    open(name) {
      const request = { result: database(name) };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
    /** Fails the next request, or the next one in database `name`, like a full disk. */
    fail: (name) => {
      failNext = name ?? true;
    },
    records,
  };
}
