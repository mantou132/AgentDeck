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
      if (path) data = (await agentApi.readRawFile(path)).data;
    } catch (error) {
      console.warn('Preview request failed:', url, error);
    }
    // Without data the protocol answers 404.
    await invoke('preview_respond', { id, path: path || '', data });
  });
};
