import { SESSION_META_KEY } from '../config';

export type LocalSessionMeta = {
  title?: string;
  updatedAt?: string;
  deleted?: boolean;
};

type CompactMeta = {
  t?: string;
  u?: string;
  d?: 1;
};

const memoryStore = new Map<string, LocalSessionMeta>();

const syncToLocalStorage = () => {
  if (typeof localStorage === 'undefined') return;
  try {
    if (memoryStore.size === 0) {
      localStorage.removeItem(SESSION_META_KEY);
      return;
    }
    const record: Record<string, CompactMeta> = {};
    for (const [id, meta] of memoryStore) {
      const item: CompactMeta = {};
      if (meta.title) item.t = meta.title;
      if (meta.updatedAt) item.u = meta.updatedAt;
      if (meta.deleted) item.d = 1;
      if (item.t !== undefined || item.u !== undefined || item.d !== undefined) {
        record[id] = item;
      }
    }
    localStorage.setItem(SESSION_META_KEY, JSON.stringify(record));
  } catch {}
};

const loadFromLocalStorage = () => {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(SESSION_META_KEY);
    if (!raw) return;
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object') return;
    for (const [id, item] of Object.entries(record as Record<string, CompactMeta>)) {
      if (id && item && typeof item === 'object') {
        memoryStore.set(id, {
          title: item.t,
          updatedAt: item.u,
          deleted: item.d === 1,
        });
      }
    }
  } catch {}
};

loadFromLocalStorage();

export const getSessionMeta = (sessionId: string): LocalSessionMeta | undefined => {
  return memoryStore.get(sessionId);
};

export const isSessionDeleted = (sessionId: string): boolean => {
  return Boolean(memoryStore.get(sessionId)?.deleted);
};

export const saveSessionMeta = (sessionId: string, patch: Partial<LocalSessionMeta>): void => {
  if (!sessionId || sessionId === 'pending-session') return;
  const existing = memoryStore.get(sessionId) ?? {};
  const title = patch.title || existing.title;
  const updatedAt = patch.updatedAt || existing.updatedAt;
  const deleted = patch.deleted ?? existing.deleted;
  memoryStore.set(sessionId, { title, updatedAt, deleted });
  syncToLocalStorage();
};

export const markSessionDeleted = (sessionId: string): void => {
  saveSessionMeta(sessionId, { deleted: true });
};
