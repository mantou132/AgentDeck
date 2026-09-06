import { I18n } from '@mantou/gem/helper/i18n';
import { loadLocale } from '@mantou/tap-ui/lib/locale';
import type { ConnectionState } from './agent/transport';
import en from './locales/en/basic.json';
import zhCN from './locales/zh-CN/basic.json';
import type { ToolStatus } from './session/timeline';

export const fallbackLanguage = 'en';

export const langNames: Record<string, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

export type Locale = typeof en;
export type LocaleKey = keyof Locale;

export const i18n = new I18n<typeof en>({
  fallbackLanguage,
  cache: true,
  resources: {
    en,
    'zh-CN': zhCN,
    zh: zhCN,
  },
  onChange: async (code: string) => {
    switch (code) {
      case 'zh-CN':
      case 'zh':
        return loadLocale(import('@mantou/tap-ui/locales/zh'));
      default:
        return loadLocale(import('@mantou/tap-ui/locales/en'));
    }
  },
});

export const getConnectionLabel = (state: ConnectionState): string => {
  return i18n.get(`connection.${state}` as LocaleKey);
};

export const getToolStatusLabel = (status: ToolStatus): string => {
  const map: Record<ToolStatus, LocaleKey> = {
    pending: 'timeline.statusPending',
    in_progress: 'timeline.statusInProgress',
    completed: 'timeline.statusCompleted',
    failed: 'timeline.statusFailed',
    ended: 'timeline.statusEnded',
  };
  return i18n.get(map[status]);
};
