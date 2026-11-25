import { I18n } from '@mantou/gem/helper/i18n';
import { loadLocale } from '@mantou/tap-ui/lib/locale';
import type { ConnectionState } from 'src/agent/transport';
import { type AppLanguage, readLanguage } from 'src/config';
import enUS from 'src/locales/en-US/basic.json';
import zhCN from 'src/locales/zh-CN/basic.json';
import type { ToolStatus } from 'src/session/timeline';

export const fallbackLanguage = 'en-US';

export type Locale = typeof enUS;
export type LocaleKey = keyof Locale;

export const i18n = new I18n<typeof enUS>({
  fallbackLanguage,
  currentLanguage: readLanguage() || undefined,
  resources: {
    'en-US': enUS,
    en: enUS,
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

export const speechLanguage = (language: AppLanguage = readLanguage()): string => language || navigator.language;

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
