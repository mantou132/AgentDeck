import { isTauri } from '@tauri-apps/api/core';

/** Mobile Tauri apps (iOS / Android), where mobile-only native plugins exist. */
export const isMobileApp = isTauri() && /Android|iPhone|iPad/i.test(navigator.userAgent);

export const isAndroidApp = isMobileApp && /Android/i.test(navigator.userAgent);
