import { throttle } from '@mantou/tap-ui/lib/timer';
import { ACTIVE_MARKER_KEY, DB_NAME, DB_VERSION, FALLBACK_KEY, STORE_NAME } from '../config';
import type { ChatMessage, DeckSession, SessionOptions } from '../session/types';

export type InFlightSession = {
  sessionId: string;
  agent: string;
  rpcId: string;
  session: DeckSession;
  messages: ChatMessage[];
  options?: SessionOptions;
  updatedAt: number;
};

export const hasActiveInFlightMarker = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(ACTIVE_MARKER_KEY) === '1';
  } catch {
    return false;
  }
};

export const markActiveInFlight = (active: boolean) => {
  try {
    if (typeof localStorage === 'undefined') return;
    if (active) {
      localStorage.setItem(ACTIVE_MARKER_KEY, '1');
    } else {
      localStorage.removeItem(ACTIVE_MARKER_KEY);
    }
  } catch {}
};

// In-memory fallback for environments without IndexedDB (e.g. Node.js unit tests)
const memoryStore = new Map<string, InFlightSession>();

const syncToLocalStorage = () => {
  if (typeof localStorage !== 'undefined') {
    try {
      if (memoryStore.size === 0) {
        localStorage.removeItem(FALLBACK_KEY);
      } else {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify(Array.from(memoryStore.values())));
      }
    } catch {}
  }
};

const loadFromLocalStorage = () => {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(FALLBACK_KEY);
      if (raw) {
        const items = JSON.parse(raw) as InFlightSession[];
        memoryStore.clear();
        for (const item of items) {
          memoryStore.set(item.sessionId, item);
        }
      }
    } catch {}
  }
};

const openDb = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), 1000);
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
        }
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        finish(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        finish(null);
      };
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
};

export const saveInFlight = async (record: InFlightSession): Promise<void> => {
  markActiveInFlight(true);
  const db = await openDb();
  if (!db) {
    memoryStore.set(record.sessionId, record);
    syncToLocalStorage();
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const throttledUpdaters = new Map<string, (messages: ChatMessage[]) => void>();

const writeMessagesToIndexedDb = async (sessionId: string, messages: ChatMessage[]): Promise<void> => {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const record = getReq.result as InFlightSession | undefined;
      if (record) {
        record.messages = messages;
        record.updatedAt = Date.now();
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const updateInFlightMessages = async (sessionId: string, messages: ChatMessage[]): Promise<void> => {
  const db = await openDb();
  if (!db) {
    const existing = memoryStore.get(sessionId);
    if (existing) {
      existing.messages = messages;
      existing.updatedAt = Date.now();
      syncToLocalStorage();
    }
    return;
  }

  // 浏览器原生环境：使用 throttle 节流写入，避免密集 chunk 造成频繁 GC 和事务开销
  let updater = throttledUpdaters.get(sessionId);
  if (!updater) {
    updater = throttle(
      (msgs: ChatMessage[]) => {
        void writeMessagesToIndexedDb(sessionId, msgs);
      },
      300,
      { leading: true, maxWait: 1000 },
    );
    throttledUpdaters.set(sessionId, updater);
  }
  updater(messages);
};

export const removeInFlight = async (sessionId: string): Promise<void> => {
  throttledUpdaters.delete(sessionId);
  const db = await openDb();
  if (!db) {
    memoryStore.delete(sessionId);
    syncToLocalStorage();
    if (memoryStore.size === 0) markActiveInFlight(false);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const all = await getAllInFlight();
  if (all.length === 0) markActiveInFlight(false);
};

export const getAllInFlight = async (): Promise<InFlightSession[]> => {
  const db = await openDb();
  if (!db) {
    loadFromLocalStorage();
    return Array.from(memoryStore.values());
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as InFlightSession[]) || []);
    request.onerror = () => reject(request.error);
  });
};

export const clearAllInFlight = async (): Promise<void> => {
  markActiveInFlight(false);
  throttledUpdaters.clear();
  const db = await openDb();
  if (!db) {
    memoryStore.clear();
    syncToLocalStorage();
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};
