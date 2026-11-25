import { initApp } from '@mantou/tap-ui/helper/webapp';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { startPreviewServer } from 'src/agent/preview';
import { startPushNotifications } from 'src/agent/push';
import { startApp } from 'src/state/app';
import { openLaunchedApp, startSavedApps } from 'src/state/saved-apps';
import { startShareTarget } from 'src/state/share';

import 'src/styles/theme';
import 'src/app';
import 'src/pages/session-list';
import 'src/pages/session';
import 'src/pages/subagent';
import 'src/pages/settings';

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
