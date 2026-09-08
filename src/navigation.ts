import { Browser } from '@mantou/tap-ui/elements/browser';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { parseMessageLink } from './lib/links';

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
  if (link.type === 'web') {
    void Browser.open({ src: link.url, title: anchor?.textContent?.trim() || link.url });
  } else {
    Stack.push({
      content: html`<deck-file-browser .path=${link.path} .cwd=${cwd} .line=${link.line}></deck-file-browser>`,
      gesture: true,
    });
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
