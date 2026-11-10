import { initApp } from '@mantou/tap-ui/helper/webapp';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { startPreviewServer } from './agent/preview';
import { startPushNotifications } from './agent/push';
import { startApp } from './state/app';
import { startShareTarget } from './state/share';

import './styles/theme';
import './app';
import './pages/session-list';
import './pages/session';
import './pages/subagent';
import './pages/settings';

initApp({
  layout: html`<agentdeck-app class="block h-full"></agentdeck-app>`,
});

startApp();
startPushNotifications();
startPreviewServer();
startShareTarget();

// Confirms a hot-updated frontend booted, see `crates/agentdeck/src/frontend_update.rs`.
if (isTauri()) invoke('frontend_update_ready');
