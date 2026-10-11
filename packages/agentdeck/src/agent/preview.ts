import { i18n } from '../i18n';
import { serve } from '../lib/js-protocol';
import { escapeHtml } from '../lib/markdown';
import { PREVIEW_SCHEME, previewSupported, resolvePreviewPath } from '../lib/preview';
import { getSafeAreaScript } from '../lib/safe-area';
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

/** Answers the `agentdeck-preview` protocol with host files read over Relay. */
export const startPreviewServer = async () => {
  if (!previewSupported) return;
  await serve(PREVIEW_SCHEME, async ({ url, host, pathname, range }) => {
    const { path, safeArea } = resolvePreviewPath(host, pathname) || {};
    try {
      if (!path) throw new Error(url);
      const { data, size } = await agentApi.readRawFile(path, range && [range.offset, range.length]);
      const body = safeArea && !range && /\.html?$/i.test(path) ? injectSafeArea(data) : data;
      return { body, size };
    } catch (error) {
      console.warn('Preview request failed:', url, error);
      const detail = error instanceof Error ? error.message : String(error);
      return { body: errorPage(detail), status: 404, contentType: 'text/html; charset=utf-8' };
    }
  });
};
