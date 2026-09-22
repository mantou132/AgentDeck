import { DEFAULT_STORAGE_KEY } from 'relay-client-ts';

export const DEVICE_ID_KEY = 'agentdeck.device_id.v1';

let cachedDeviceId = null;

export async function getExtensionDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const items = await chrome.storage.local.get(DEVICE_ID_KEY);
    let id = items[DEVICE_ID_KEY];
    if (typeof id !== 'string' || !id) {
      id = crypto.randomUUID();
      await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
    }
    cachedDeviceId = id;
    return id;
  } catch {
    cachedDeviceId = crypto.randomUUID();
    return cachedDeviceId;
  }
}

export function createChromeStorageStore(relayId, storageKey = DEFAULT_STORAGE_KEY, getDeviceId = () => '') {
  const load = async () => {
    try {
      const items = await chrome.storage.local.get(storageKey);
      const raw = items[storageKey];
      const deviceId = getDeviceId() || (await getExtensionDeviceId());
      if (!raw) {
        const fresh = { relayId, deviceId, outbox: [] };
        await chrome.storage.local.set({ [storageKey]: fresh });
        return fresh;
      }
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const state = {
        relayId,
        deviceId: parsed.deviceId || deviceId,
        lastReceived: parsed.relayId === relayId ? parsed.lastReceived : undefined,
        outbox: parsed.relayId === relayId && Array.isArray(parsed.outbox) ? parsed.outbox : [],
      };
      if (!parsed.deviceId || parsed.relayId !== relayId) {
        await chrome.storage.local.set({ [storageKey]: state });
      }
      return state;
    } catch {
      const deviceId = getDeviceId() || (await getExtensionDeviceId());
      const fallback = { relayId, deviceId, outbox: [] };
      try {
        await chrome.storage.local.set({ [storageKey]: fallback });
      } catch {}
      return fallback;
    }
  };

  return {
    outbox: async () => {
      const state = await load();
      return state.outbox;
    },
    enqueue: async (message) => {
      const state = await load();
      state.outbox.push(message);
      await chrome.storage.local.set({ [storageKey]: state });
    },
    removeFromOutbox: async (messageId) => {
      const state = await load();
      state.outbox = state.outbox.filter((m) => m.messageId !== messageId);
      await chrome.storage.local.set({ [storageKey]: state });
    },
    lastReceived: async () => {
      const state = await load();
      return state.lastReceived;
    },
    markReceived: async (sequence) => {
      const state = await load();
      state.lastReceived = sequence;
      await chrome.storage.local.set({ [storageKey]: state });
    },
    deviceId: async () => {
      const state = await load();
      return state.deviceId;
    },
  };
}

export async function clearExtensionTransportStorage() {
  cachedDeviceId = null;
  try {
    await chrome.storage.local.remove([DEFAULT_STORAGE_KEY, DEVICE_ID_KEY]);
  } catch {}
}
