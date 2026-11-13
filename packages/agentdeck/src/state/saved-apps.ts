import { Toast } from '@mantou/tap-ui/elements/toast';
import { arrayBufferToBase64 } from '@mantou/tap-ui/lib/encode';
import { createBitmapFromSvg } from '@mantou/tap-ui/lib/image';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { agentApi } from '../agent/transport';
import { LAUNCH_LINK_TAKEN_KEY } from '../config';
import { protocolUrl } from '../lib/js-protocol';

// Apps built with the host's `app` skill, saved on the phone by `crates/agentdeck/src/saved_apps.rs`.

/** `agentdeck.json` next to the built `index.html`. */
export type AppManifest = { id: string; name: string };

/** Home screen entries are for the phone App. */
export const savedAppsSupported = isTauri() && /Android|iPhone|iPad/i.test(navigator.userAgent);

/** Android pins a launcher shortcut per app; iOS opens them from the AgentDeck widget. */
export const pinSupported = savedAppsSupported && /Android/i.test(navigator.userAgent);

export const savedAppsStore = createStore({ apps: [] as AppManifest[] });

const APP_SCHEME = 'agentdeck-app';
/** Next to the app's files, under the path AgentDeck reserves (`/__agentdeck/exit` leaves the app). */
const SAVED_ICON_PATH = '__agentdeck/icon.png';

/** The saved copy's own `icon.svg`. */
export const savedAppIconUrl = (id: string) => protocolUrl(APP_SCHEME, id, '/icon.svg');

export const loadSavedApps = async () => {
  savedAppsStore({ apps: await invoke<AppManifest[]>('saved_app_list') });
};

const dirname = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

const readHostFile = async (path: string) =>
  new Uint8Array(await new Blob(await agentApi.readWholeRawFile(path)).arrayBuffer());

/** `agentdeck.json` of the build that `entry` (its `index.html`) belongs to. */
export const readAppManifest = async (entry: string): Promise<AppManifest> =>
  JSON.parse(new TextDecoder().decode(await readHostFile(`${dirname(entry)}/agentdeck.json`)));

/** Files under a host directory, recursively. */
const listFiles = async (dir: string): Promise<string[]> => {
  const { entries } = await agentApi.browseFiles(dir, { limit: 500 });
  const files = await Promise.all(entries.map((entry) => (entry.isDirectory ? listFiles(entry.path) : [entry.path])));
  return files.flat();
};

/** Home screen entries can't draw SVG, so `icon.svg` is saved as a 512 px PNG too. */
const rasterizeIcon = async (svg: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await (await createBitmapFromSvg(new TextDecoder().decode(svg))).arrayBuffer());

/** Copies the build that `entry` belongs to onto the phone, replacing an earlier copy. */
export const saveApp = async (entry: string) => {
  const dir = dirname(entry);
  const manifest = await readAppManifest(entry);
  const { id } = manifest;
  const write = (path: string, data: Uint8Array<ArrayBuffer>) =>
    invoke('saved_app_write', { id, path, data: arrayBufferToBase64(data.buffer) });
  await invoke('saved_app_begin', { id });
  try {
    for (const file of await listFiles(dir)) {
      const path = file.slice(dir.length + 1).replaceAll('\\', '/');
      const data = await readHostFile(file);
      await write(path, data);
      if (path === 'icon.svg') await write(SAVED_ICON_PATH, await rasterizeIcon(data));
    }
    await invoke('saved_app_commit', { id });
  } catch (error) {
    // Reports the save's own error, not a failed cleanup.
    await invoke('saved_app_discard', { id }).catch((cleanup) =>
      console.warn('Discarding staged app failed:', cleanup),
    );
    throw error;
  }
  await loadSavedApps();
  return manifest;
};

export const removeSavedApp = async (id: string) => {
  await invoke('saved_app_remove', { id });
  await loadSavedApps();
};

/** Asks the Android launcher to pin a shortcut opening the app. */
export const pinSavedApp = ({ id, name }: AppManifest) => invoke('saved_app_pin', { id, name });

/** Leaves AgentDeck for the saved app, which takes over the window until it exits. */
export const openSavedApp = (id: string) => invoke('saved_app_open', { id });

/** Id in an `agentdeck://app/<id>` link, which home screen entries open. */
const linkedAppId = (url: string) => /^agentdeck:\/\/app\/([a-z][a-z0-9]*)$/.exec(url)?.[1];

const showError = (error: unknown) => Toast.open('error', error instanceof Error ? error.message : String(error));

/**
 * Opens the saved app whose home screen entry started the App, before AgentDeck renders, so AgentDeck doesn't flash
 * in between. The link stays current in the plugin for the whole launch, and AgentDeck reloads each time an app
 * exits, so it is taken once per launch. Resolves whether an app is opening.
 */
export const openLaunchedApp = async () => {
  if (!savedAppsSupported || sessionStorage.getItem(LAUNCH_LINK_TAKEN_KEY)) return false;
  sessionStorage.setItem(LAUNCH_LINK_TAKEN_KEY, '1');
  const id = (await getCurrent())?.map(linkedAppId).find(Boolean);
  if (!id) return false;
  try {
    await openSavedApp(id);
    return true;
  } catch (error) {
    // AgentDeck boots instead and shows why.
    setTimeout(() => showError(error));
    return false;
  }
};

/**
 * Loads the saved apps, and opens the one a home screen entry links to while AgentDeck shows; while an app shows,
 * Rust handles links.
 */
export const startSavedApps = async () => {
  if (!savedAppsSupported) return;
  await loadSavedApps();
  await onOpenUrl(async (urls) => {
    const id = urls.map(linkedAppId).find(Boolean);
    if (!id) return;
    try {
      await openSavedApp(id);
    } catch (error) {
      showError(error);
    }
  });
};
