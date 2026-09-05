import { initApp } from '@mantou/tap-ui/helper/webapp';

import { startApp } from './state/app';

import './styles/theme';
import './app';
import './pages/session-list';
import './pages/session';
import './pages/settings';

initApp({
  template: html`<agentdeck-app class="block h-full"></agentdeck-app>`,
});

startApp();
