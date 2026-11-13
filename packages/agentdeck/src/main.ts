import { initApp } from '@mantou/tap-ui/helper/webapp';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { startPreviewServer } from './agent/preview';
import { startPushNotifications } from './agent/push';
import { startApp } from './state/app';
import { openLaunchedApp, startSavedApps } from './state/saved-apps';
import { startShareTarget } from './state/share';

import './styles/theme';
import './app';
import './pages/session-list';
import './pages/session';
import './pages/subagent';
import './pages/settings';

const start = async () => {
  // Confirms a hot-updated frontend booted, see `crates/agentdeck/src/frontend_update.rs`; before opening a saved app,
  // which leaves this page.
  if (isTauri()) await invoke('frontend_update_ready');
  if (await openLaunchedApp()) return;

  initApp({
    layout: html`<agentdeck-app class="block h-full"></agentdeck-app>`,
  });

  startApp();
  startPushNotifications();
  startPreviewServer();
  startShareTarget();
  startSavedApps();
};

start();
