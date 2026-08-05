import type { RouteItem } from '@mantou/tap-ui/elements/route';

import './home';
import './settings';
import './starred';

export const routes = {
  home: {
    pattern: '/',
    title: '今日',
    getContent() {
      return html`<flowday-home></flowday-home>`;
    },
  },
  starred: {
    pattern: '/starred',
    title: '收藏',
    getContent() {
      return html`<flowday-starred></flowday-starred>`;
    },
  },
  settings: {
    pattern: '/settings',
    title: '设置',
    getContent() {
      return html`<flowday-settings></flowday-settings>`;
    },
  },
} satisfies Record<string, RouteItem>;
