import { isTauri } from '@tauri-apps/api/core';
import {
  checkPermissions,
  createChannel,
  getToken,
  onPushError,
  onTokenRefresh,
  register,
  requestPermissions,
} from 'tauri-plugin-fcm';
import { updateFcmToken } from './transport';

export const startPushNotifications = async () => {
  if (!isTauri()) return;

  const syncToken = async () => {
    try {
      let perm = await checkPermissions();
      if (perm === 'prompt' || perm === 'prompt-with-rationale') {
        perm = await requestPermissions();
      }
      if (perm !== 'granted') {
        updateFcmToken(null);
        return;
      }
      await register();
      const { token } = await getToken();
      updateFcmToken(token || null);
    } catch (error) {
      // FCM availability must not block the Relay connection or erase a known token.
      console.error('Failed to register for push notifications:', error);
    }
  };

  try {
    if (/Android/i.test(navigator.userAgent)) {
      await createChannel({
        id: 'agent_responses',
        name: 'Agent responses',
        importance: 3,
      });
    }

    await onTokenRefresh(({ token }) => updateFcmToken(token));
    await onPushError(({ error }) => {
      console.error('FCM push error:', error);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncToken();
    });
    await syncToken();
  } catch (error) {
    console.error('Failed to initialize push notifications:', error);
  }
};
