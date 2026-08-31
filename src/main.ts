import { initApp } from '@mantou/tap-ui/helper/webapp';

import { startAcpTransport } from './session-store';

import './theme';
import './menu';
import './session';

initApp({
  // The session list is the root page. Individual sessions enter through Stack.
  template: html`<agentdeck-menu-page class="block h-full"></agentdeck-menu-page>`,
});

startAcpTransport();
