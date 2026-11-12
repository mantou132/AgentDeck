import { initApp } from '@mantou/tap-ui/helper/webapp';
import { AppSheetHostElement } from './sheet';

import './theme';

// Renders the root page into the global Stack; `Stack.push` opens pages above it
initApp({
  template: html`<app-home class="block h-full"></app-home>`,
});

// After the Stack, so sheets cover every page
document.body.append(new AppSheetHostElement());
