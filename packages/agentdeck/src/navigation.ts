import { Browser } from '@mantou/tap-ui/elements/browser';
import { Stack, type TapStackElement } from '@mantou/tap-ui/elements/stack';
import { onWebProxyState } from 'tauri-plugin-webproxy-api';
import { agentApi } from './agent/transport';
import { parseMessageLink } from './lib/links';

export const openWebBrowser = async (url: string, title = '') => {
  const result = Browser.open({ src: url, title });
  await new Promise((res) => requestAnimationFrame(res));
  onWebProxyState(result.browser.contentWindow, (state) => {
    const url = new URL(state.url);
    if (!['https:', 'http:', 'webproxy:'].includes(url.protocol)) {
      // openExtraUri(url.href);
      return;
    }
    if (state.target === '_blank') {
      openWebBrowser(state.url, state.title);
    } else {
      result.browser.title = state.title;
      result.browser.src = state.url;
    }
  });
  return result;
};

export const openFileBrowser = (path: string, cwd: string, stack?: TapStackElement | null) => {
  (stack || Stack).push({
    content: html`<deck-file-browser-page .path=${path} .cwd=${cwd}></deck-file-browser-page>`,
    gesture: true,
  });
};

export const openFileViewer = (path: string, cwd: string, line?: number, stack?: TapStackElement | null) => {
  (stack || Stack).push({
    content: html`<deck-file-viewer .path=${path} .cwd=${cwd} .line=${line}></deck-file-viewer>`,
    gesture: true,
  });
};

export const openChanges = (cwd: string) => {
  Stack.push({
    content: html`<deck-changes-page .cwd=${cwd}></deck-changes-page>`,
    gesture: true,
  });
};

export const openChangesDiff = (path: string, cwd: string) => {
  Stack.push({
    content: html`<deck-changes-diff-page .path=${path} .cwd=${cwd}></deck-changes-diff-page>`,
    gesture: true,
  });
};

export const openPath = async (path: string, cwd: string, line?: number, stack?: TapStackElement | null) => {
  if (path.endsWith('/') || path.endsWith('\\') || path === '.' || path === '..') {
    openFileBrowser(path, cwd, stack);
    return;
  }
  if (line) {
    openFileViewer(path, cwd, line, stack);
    return;
  }
  try {
    await agentApi.browseFiles(path, { cwd, limit: 1 });
    openFileBrowser(path, cwd, stack);
  } catch {
    openFileViewer(path, cwd, undefined, stack);
  }
};

export const openMessageLink = (event: MouseEvent, cwd: string, targetStack?: TapStackElement | null) => {
  if (event.defaultPrevented || event.button !== 0) return false;
  const anchor = event
    .composedPath()
    .find((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
  const href = anchor?.getAttribute('href');
  if (!href || href.startsWith('#')) return false;
  event.preventDefault();
  const link = parseMessageLink(href);
  if (!link) return false;
  if (link.type === 'web') {
    openWebBrowser(link.url, anchor?.textContent?.trim() || link.url);
  } else {
    const stack = targetStack || (anchor ? Stack.getClosestStack(anchor) : undefined);
    void openPath(link.path, cwd, link.line, stack);
  }
  return true;
};

export const openSettings = () => {
  Stack.push({
    content: html`<agentdeck-settings-page class="block h-full" .canGoBack=${true}></agentdeck-settings-page>`,
    gesture: true,
  });
};

export const openSession = (sessionId: string) => {
  Stack.push({
    content: html`
      <agentdeck-session-page class="block h-full" .sessionId=${sessionId}></agentdeck-session-page>
    `,
    gesture: true,
  });
};
