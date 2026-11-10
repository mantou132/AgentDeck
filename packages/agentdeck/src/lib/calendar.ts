import { isTauri } from '@tauri-apps/api/core';

/** Only the mobile apps have the system event editor `tauri-plugin-add-to-calendar` opens. */
export const calendarSupported = isTauri() && /Android|iPhone|iPad/i.test(navigator.userAgent);
