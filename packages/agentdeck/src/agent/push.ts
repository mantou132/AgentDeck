import {
  checkPermissions,
  createChannel,
  getToken,
  onNotificationOpened,
  onPushError,
  onTokenRefresh,
  register,
  requestPermissions,
  takeOpenedNotification,
} from '@mantou/tauri-plugin-fcm';
import { isTauri } from '@tauri-apps/api/core';
import { getOpenSessionId, selectSession } from '../navigation';
import { saveSettings } from '../state/app';
import { getSession, refreshSessions } from '../state/sessions';
import { agentdeckStore, sessionsStore } from '../state/store';
import { pushHostKey } from './encryption';
import { updateFcmToken } from './transport';

/** `data` of the push sent by the daemon's `push::send`. */
type PushData = { type?: string; host?: string; agent?: string; sessionId?: string };

/**
 * Opens the session of a tapped push. Taps on another host's pushes only bring the App forward; for another agent of
 * this host the App switches to it first. The session page waits for the list to have the session before loading it.
 */
const openPushedSession = ({ type, host, agent, sessionId }: PushData) => {
  const { settings } = agentdeckStore;
  if (type !== 'response_complete' || !agent || !sessionId || host !== pushHostKey(settings.relayId)) return;
  if (agent !== settings.agent) {
    saveSettings({ ...settings, agent });
  } else if (!getSession(sessionId) && sessionsStore.sessionsLoaded) {
    // Started elsewhere after the list loaded.
    refreshSessions();
  }
  if (getOpenSessionId() !== sessionId) selectSession(sessionId);
};

const openTappedPush = async () => {
  const data = await takeOpenedNotification();
  if (data) openPushedSession(data);
};

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
    // A tap that cold-started the App waits in the plugin until taken.
    await onNotificationOpened(openTappedPush);
    await openTappedPush();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncToken();
    });
    await syncToken();
  } catch (error) {
    console.error('Failed to initialize push notifications:', error);
  }
};
