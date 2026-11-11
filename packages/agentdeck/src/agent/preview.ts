import { connect } from '@mantou/gem';
import { i18n } from '../i18n';
import { serve } from '../lib/js-protocol';
import { escapeHtml } from '../lib/markdown';
import { PREVIEW_SCHEME, previewSupported, resolvePreviewPath } from '../lib/preview';
import { getSafeAreaScript } from '../lib/safe-area';
import { agentdeckStore, isConnecting } from '../state/store';
import { agentApi } from './transport';

// A body with a content type lets the frame finish loading; WebKit never fires `load` for an untyped empty 404.
const errorPage = (detail: string) => `<!doctype html>
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light dark">
<style>body { font-family: system-ui; padding: 1rem; } pre { white-space: pre-wrap; word-break: break-all; }</style>
<h3>${escapeHtml(i18n.get('preview.loadFailed'))}</h3>
<pre>${escapeHtml(detail)}</pre>`;

// After the doctype so the page stays in standards mode.
const injectSafeArea = (data: Uint8Array) => {
  const page = new TextDecoder().decode(data);
  const at = page.match(/^\s*<!doctype[^>]*>/i)?.[0].length || 0;
  return `${page.slice(0, at)}<script>${getSafeAreaScript()}</script>${page.slice(at)}`;
};

// Android's WebView gives up on a protocol request after 30 s (wry's `MAIN_PIPE_TIMEOUT * 3`), so a wait stays below it.
const RECONNECT_WAIT_MS = 20_000;

/** Resolves once automatic reconnection ends (connected or failed), or after `RECONNECT_WAIT_MS`. */
const reconnected = () =>
  new Promise<void>((resolve) => {
    if (!isConnecting()) return resolve();
    const done = () => {
      clearTimeout(timer);
      disconnect();
      resolve();
    };
    const timer = setTimeout(done, RECONNECT_WAIT_MS);
    const disconnect = connect(agentdeckStore, () => !isConnecting() && done());
  });

/**
 * `file_read` is ephemeral: it fails at once while the host is unreachable, and fails when the connection drops
 * since its reply is never replayed (e.g. switching apps mid-load). The request waits out reconnection instead,
 * so images and pages keep loading rather than break.
 */
const readHostFile = async (path: string, range?: [number, number]) => {
  if (isConnecting()) console.info('Preview read waits for reconnection:', path, agentdeckStore.connection);
  await reconnected();
  try {
    return await agentApi.readRawFile(path, range);
  } catch (error) {
    if (!isConnecting()) throw error;
    console.warn('Preview read interrupted, retrying after reconnection:', path, error);
    await reconnected();
    return agentApi.readRawFile(path, range);
  }
};

/** Answers the `agentdeck-preview` protocol with host files read over Relay. */
export const startPreviewServer = async () => {
  if (!previewSupported) return;
  await serve(PREVIEW_SCHEME, async ({ url, host, pathname, range }) => {
    const { path, safeArea } = resolvePreviewPath(host, pathname) || {};
    try {
      if (!path) throw new Error(url);
      const { data, size } = await readHostFile(path, range && [range.offset, range.length]);
      const body = safeArea && !range && /\.html?$/i.test(path) ? injectSafeArea(data) : data;
      return { body, size };
    } catch (error) {
      console.warn('Preview request failed:', url, agentdeckStore.connection, error);
      const detail = error instanceof Error ? error.message : String(error);
      return { body: errorPage(detail), status: 404, contentType: 'text/html; charset=utf-8' };
    }
  });
};
