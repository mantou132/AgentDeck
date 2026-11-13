import { initApp } from '@mantou/tap-ui/helper/webapp';
import { AppSheetHostElement } from './sheet';

import './theme';

// Saved to the phone, the app takes over AgentDeck's window (`agentdeck-app://<id>`, `https://agentdeck-app.<id>` on Android)
const saved = location.protocol === 'agentdeck-app:' || location.hostname.startsWith('agentdeck-app.');

// Renders the root page into the global Stack; `Stack.push` opens pages above it
initApp({
  template: html`<app-home class="block h-full"></app-home>`,
  // Swiping back on the root page, or `Stack.pop()` there, returns to AgentDeck
  onRootClose: saved ? () => location.assign('/__agentdeck/exit') : undefined,
});

// After the Stack, so sheets cover every page
document.body.append(new AppSheetHostElement());
