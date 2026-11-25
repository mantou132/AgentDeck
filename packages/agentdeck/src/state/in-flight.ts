import { throttle } from '@mantou/tap-ui/lib/timer';
import { ACTIVE_MARKER_KEY, DATABASES } from 'src/config';
import { createDatabaseStore } from 'src/lib/database';
import type { ChatMessage, DeckSession, SessionOptions } from 'src/session/types';

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
    return localStorage.getItem(ACTIVE_MARKER_KEY) === '1';
  } catch {
    return false;
  }
};

export const markActiveInFlight = (active: boolean) => {
  try {
    if (active) {
      localStorage.setItem(ACTIVE_MARKER_KEY, '1');
    } else {
      localStorage.removeItem(ACTIVE_MARKER_KEY);
    }
  } catch {}
};

const records = createDatabaseStore<InFlightSession>(DATABASES.inFlight);
const throttledUpdaters = new Map<string, (messages: ChatMessage[]) => void>();

export const saveInFlight = async (record: InFlightSession): Promise<void> => {
  markActiveInFlight(true);
  await records.set(record.sessionId, record);
};

export const updateInFlightMessages = (sessionId: string, messages: ChatMessage[]): void => {
  let updater = throttledUpdaters.get(sessionId);
  if (!updater) {
    updater = throttle(
      (msgs: ChatMessage[]) => {
        records.update(sessionId, (record) =>
          record ? { ...record, messages: msgs, updatedAt: Date.now() } : undefined,
        );
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
  await records.delete(sessionId);
  if ((await records.getAll()).length === 0) markActiveInFlight(false);
};

export const getAllInFlight = records.getAll;

export const clearAllInFlight = async (): Promise<void> => {
  markActiveInFlight(false);
  throttledUpdaters.clear();
  await records.clear();
};
