import { DEFAULT_STORAGE_KEY, type OutboundMessage, type RelayStore } from 'relay-client-ts';

const DEVICE_ID_KEY = 'agentdeck.device_id.v1';

type StoredTransport = {
  relayId: string;
  deviceId: string;
  lastReceived?: number;
  outbox: OutboundMessage[];
};

let cachedDeviceId: string | undefined;

export async function getExtensionDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const items = await chrome.storage.local.get(DEVICE_ID_KEY);
    let id = items[DEVICE_ID_KEY];
    if (typeof id !== 'string' || !id) {
      id = crypto.randomUUID();
      await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
    }
    cachedDeviceId = id as string;
  } catch {
    cachedDeviceId = crypto.randomUUID();
  }
  return cachedDeviceId;
}

/** `relay-client-ts` store on `chrome.storage.local`; one Relay route's state is kept at a time. */
export function createChromeStorageStore(relayId: string, deviceId: string): RelayStore {
  const save = (state: StoredTransport) => chrome.storage.local.set({ [DEFAULT_STORAGE_KEY]: state });

  const load = async (): Promise<StoredTransport> => {
    try {
      const items = await chrome.storage.local.get(DEFAULT_STORAGE_KEY);
      const raw = items[DEFAULT_STORAGE_KEY];
      if (!raw) {
        const fresh = { relayId, deviceId, outbox: [] };
        await save(fresh);
        return fresh;
      }
      const parsed: Partial<StoredTransport> = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const sameRoute = parsed.relayId === relayId;
      const state = {
        relayId,
        deviceId: parsed.deviceId || deviceId,
        lastReceived: sameRoute ? parsed.lastReceived : undefined,
        outbox: sameRoute && Array.isArray(parsed.outbox) ? parsed.outbox : [],
      };
      if (!parsed.deviceId || !sameRoute) await save(state);
      return state;
    } catch {
      const fallback = { relayId, deviceId, outbox: [] };
      await save(fallback).catch(() => {});
      return fallback;
    }
  };

  return {
    outbox: async () => (await load()).outbox,
    enqueue: async (message) => {
      const state = await load();
      state.outbox.push(message);
      await save(state);
    },
    removeFromOutbox: async (messageId) => {
      const state = await load();
      state.outbox = state.outbox.filter((m) => m.messageId !== messageId);
      await save(state);
    },
    lastReceived: async () => (await load()).lastReceived,
    markReceived: async (sequence) => {
      const state = await load();
      state.lastReceived = sequence;
      await save(state);
    },
    deviceId: async () => (await load()).deviceId,
  };
}
