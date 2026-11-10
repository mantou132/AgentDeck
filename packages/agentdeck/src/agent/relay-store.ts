// Relay outbox and receive cursor in IndexedDB. Shared with the extension.
// localStorage (and chrome.storage) quotas are too small for prompts carrying attachments.
import type { OutboundMessage, RelayStore } from 'relay-client-ts';
import { DATABASES } from '../config';
import { createDatabaseStore } from '../lib/database';

type Cursor = { routeId: string; lastReceived?: number };
type Queued = { order: number; message: OutboundMessage };

// Queued messages are keyed by message id; the cursor names the route that owns the records.
const CURSOR_KEY = 'cursor';
const records = createDatabaseStore<Cursor | Queued>(DATABASES.relay);

export const clearRelayStore = () => records.clear();

/** Keeps only one route, like relay-client's localStorage store: switching route drops the old queue and cursor. */
export const indexedDbRelayStore = (routeId: string): RelayStore => {
  let order = 0;
  let cursor: Cursor = { routeId };
  const ready = records.get(CURSOR_KEY).then(async (stored) => {
    if (stored && 'routeId' in stored && stored.routeId === routeId) {
      cursor = stored;
    } else {
      await records.clear();
      await records.set(CURSOR_KEY, cursor);
    }
  });

  return {
    outbox: async () => {
      await ready;
      return (await records.getAll())
        .filter((record): record is Queued => 'message' in record)
        .sort((a, b) => a.order - b.order)
        .map((record) => record.message);
    },
    enqueue: async (message) => {
      await ready;
      order = Math.max(Date.now(), order + 1);
      await records.set(message.messageId, { order, message });
    },
    removeFromOutbox: async (messageId) => {
      await ready;
      await records.delete(messageId);
    },
    lastReceived: async () => {
      await ready;
      return cursor.lastReceived;
    },
    markReceived: async (sequence) => {
      await ready;
      cursor = { routeId, lastReceived: sequence };
      await records.set(CURSOR_KEY, cursor);
    },
  };
};
