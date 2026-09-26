import { Browser } from '@mantou/tap-ui/elements/browser';
import { Stack, type TapStackElement } from '@mantou/tap-ui/elements/stack';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { share } from '@vnidrop/tauri-plugin-share';
import { onWebProxyState, toWebproxyUrl } from 'tauri-plugin-webproxy-api';
import { agentApi } from './agent/transport';
import { i18n } from './i18n';
import { parseMessageLink } from './lib/links';

export const openWebBrowser = async (url: string, title = '', stack?: TapStackElement) => {
  let currentUrl = url
  const result = Browser.open({
    src: toWebproxyUrl(url),
    title,
    stack,
    actions: [
      {
        label: i18n.get('browser.share'),
        handler: async () => {
          (navigator.canShare?.() ? navigator.share : share)({
            title: result.browser.title || title,
            url: currentUrl,
          });
        },
      },
      {
        label: i18n.get('browser.copy'),
        handler: async () => {
          await navigator.clipboard.writeText(currentUrl);
          Toast.open('success', i18n.get('browser.copied'));
        },
      },
    ],
  });
  await new Promise((res) => requestAnimationFrame(res));
  onWebProxyState(result.browser.contentWindow, (state) => {
    const url = new URL(state.url);
    if (!['https:', 'http:', 'webproxy:'].includes(url.protocol)) {
      // openExtraUri(url.href);
      return;
    }
    if (state.target === '_blank') {
      openWebBrowser(state.url, state.title, stack);
    } else {
      result.browser.title = state.title;
      result.browser.src = toWebproxyUrl(state.url);
      currentUrl = state.url;
    }
  });
  return result;
};

export const openFileBrowser = (path: string, cwd: string, stack?: TapStackElement) => {
  (stack || Stack).push({
    content: html`<deck-file-browser-page .path=${path} .cwd=${cwd}></deck-file-browser-page>`,
    gesture: true,
  });
};

export const openFileViewer = (path: string, cwd: string, line?: number, stack?: TapStackElement) => {
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

export const openPath = async (path: string, cwd: string, line?: number, stack?: TapStackElement) => {
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

export const openMessageLink = (event: MouseEvent, cwd: string) => {
  if (event.defaultPrevented || event.button !== 0) return false;
  const anchor = event
    .composedPath()
    .find((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
  const href = anchor?.getAttribute('href');
  if (!href || href.startsWith('#')) return false;
  event.preventDefault();
  const link = parseMessageLink(href);
  if (!link) return false;
  const stack = anchor ? Stack.getClosestStack(anchor) : undefined;
  if (link.type === 'web') {
    openWebBrowser(link.url, anchor?.textContent?.trim() || link.url, stack);
  } else {
    openPath(link.path, cwd, link.line, stack);
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
