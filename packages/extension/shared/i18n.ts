import type messages from '../_locales/en/messages.json';

const DEFAULT_LOCALE = 'zh-CN';

export type MessageKey = keyof typeof messages;

export function getLocale() {
  const language = chrome.i18n.getUILanguage?.() || DEFAULT_LOCALE;
  return language.toLowerCase().startsWith('en') ? 'en' : DEFAULT_LOCALE;
}

export function t(key: MessageKey, substitutions?: string | number | (string | number)[]) {
  const values = Array.isArray(substitutions) ? substitutions.map(String) : substitutions?.toString();
  return chrome.i18n.getMessage(key, values) || key;
}

export function setPageI18n() {
  document.documentElement.lang = getLocale();
}
