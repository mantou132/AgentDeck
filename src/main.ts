import { initApp } from '@mantou/tap-ui/helper/webapp';

import { startApp } from './session-store';

import './theme';
import './app';
import './cwd-picker';
import './menu';
import './session';
import './settings';

initApp({
  template: html`<agentdeck-app class="block h-full"></agentdeck-app>`,
});

startApp();
