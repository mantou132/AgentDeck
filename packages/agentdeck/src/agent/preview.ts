import { arrayBufferToBase64 } from '@mantou/tap-ui/lib/encode';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { i18n } from '../i18n';
import { escapeHtml } from '../lib/markdown';
import { previewSupported, resolvePreviewPath } from '../lib/preview';
import { agentApi } from './transport';

type PreviewRequest = { id: number; url: string; range?: [number, number] };

// Android IPC would serialize raw bytes as a JSON number array, so they cross as base64.
const toBase64 = (bytes: Uint8Array) => arrayBufferToBase64(bytes.buffer);

// A body with a content type lets the frame finish loading; WebKit never fires `load` for an untyped empty 404.
const errorPage = (detail: string) => `<!doctype html>
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light dark">
<style>body { font-family: system-ui; padding: 1rem; } pre { white-space: pre-wrap; word-break: break-all; }</style>
<h3>${escapeHtml(i18n.get('preview.loadFailed'))}</h3>
<pre>${escapeHtml(detail)}</pre>`;

/** Answers the native `agentdeck-preview` protocol with host files read over Relay. */
export const startPreviewServer = async () => {
  if (!previewSupported) return;
  await listen<PreviewRequest>('preview-request', async ({ payload: { id, url, range } }) => {
    const path = resolvePreviewPath(url);
    try {
      if (!path) throw new Error(url);
      const { data, size } = await agentApi.readRawFile(path, range);
      await invoke('preview_respond', { id, path, data: toBase64(data), status: 200, size });
    } catch (error) {
      console.warn('Preview request failed:', url, error);
      const page = new TextEncoder().encode(errorPage(error instanceof Error ? error.message : String(error)));
      await invoke('preview_respond', { id, path: 'error.html', data: toBase64(page), status: 404 });
    }
  });
};
