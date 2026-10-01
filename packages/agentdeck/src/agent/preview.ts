import { arrayBufferToBase64 } from '@mantou/tap-ui/lib/encode';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { previewSupported, resolvePreviewPath } from '../lib/preview';
import { agentApi } from './transport';

type PreviewRequest = { id: number; url: string };

/** Answers the native `agentdeck-preview` protocol with host files read over Relay. */
export const startPreviewServer = async () => {
  if (!previewSupported) return;
  await listen<PreviewRequest>('preview-request', async ({ payload: { id, url } }) => {
    let path: string | undefined;
    let data: string | undefined;
    try {
      path = resolvePreviewPath(url);
      // Android IPC would serialize raw bytes as a JSON number array, so they cross as base64.
      if (path) data = arrayBufferToBase64((await agentApi.readRawFile(path)).data.buffer);
    } catch (error) {
      console.warn('Preview request failed:', url, error);
    }
    // Without data the protocol answers 404.
    await invoke('preview_respond', { id, path: path || '', data });
  });
};
