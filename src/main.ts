import { initApp } from '@mantou/tap-ui/helper/webapp';

import { startApp } from './store';

import './theme';
import './app';
import './session-list';
import './session';
import './settings';

initApp({
  template: html`<agentdeck-app class="block h-full"></agentdeck-app>`,
});

startApp();
