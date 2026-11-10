const DEVICE_ID_KEY = 'agentdeck.device_id.v1';

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
