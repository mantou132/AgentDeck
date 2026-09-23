import { throttle } from '@mantou/tap-ui/lib/timer';
import { ACTIVE_MARKER_KEY, DATABASES, FALLBACK_KEY } from '../config';
import { createDatabaseStore } from '../lib/database';
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

const records = createDatabaseStore<InFlightSession>(DATABASES.inFlight);
const available = () =>
  records.ready().then(
    () => true,
    () => false,
  );

export const saveInFlight = async (record: InFlightSession): Promise<void> => {
  markActiveInFlight(true);
  const persisted = await available();
  if (!persisted) {
    memoryStore.set(record.sessionId, record);
    syncToLocalStorage();
    return;
  }
  await records.set(record.sessionId, record);
};

const throttledUpdaters = new Map<string, (messages: ChatMessage[]) => void>();

const writeMessagesToIndexedDb = async (sessionId: string, messages: ChatMessage[]): Promise<void> => {
  const persisted = await available();
  if (!persisted) return;
  await records.update(sessionId, (record) => (record ? { ...record, messages, updatedAt: Date.now() } : undefined));
};

export const updateInFlightMessages = async (sessionId: string, messages: ChatMessage[]): Promise<void> => {
  const persisted = await available();
  if (!persisted) {
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
        writeMessagesToIndexedDb(sessionId, msgs);
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
  const persisted = await available();
  if (!persisted) {
    memoryStore.delete(sessionId);
    syncToLocalStorage();
    if (memoryStore.size === 0) markActiveInFlight(false);
    return;
  }
  await records.delete(sessionId);
  const all = await getAllInFlight();
  if (all.length === 0) markActiveInFlight(false);
};

export const getAllInFlight = async (): Promise<InFlightSession[]> => {
  const persisted = await available();
  if (!persisted) {
    loadFromLocalStorage();
    return Array.from(memoryStore.values());
  }
  return records.getAll();
};

export const clearAllInFlight = async (): Promise<void> => {
  markActiveInFlight(false);
  throttledUpdaters.clear();
  const persisted = await available();
  if (!persisted) {
    memoryStore.clear();
    syncToLocalStorage();
    return;
  }
  await records.clear();
};
