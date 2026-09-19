import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import { isPairingId } from '../agent/encryption';
import { clearTransportStorage, initTransport, startTransport, type TransportMessage } from '../agent/transport';
import { type AppSettings, RESET_PENDING_KEY, SETTINGS_KEY } from '../config';
import { i18n } from '../i18n';
import { getSortedSessionGroups } from '../session/groups';
import { requestPermission as requestTurnPermission } from '../session/turn';
import { clearAllInFlight, getAllInFlight, hasActiveInFlightMarker } from './in-flight';
import {
  applySessionEvent,
  endSession,
  getSession,
  refreshSessions,
  resetRemoteState,
  resumeInFlightTurn,
} from './sessions';
import { agentdeckStore } from './store';

/**
 * 唯一的底层消息消费中枢：
 * Web socket 连接与 App 状态彻底解耦，App 仅在此单一点响应状态与消息。
 */
const handleTransportMessage = (message: TransportMessage) => {
  switch (message.type) {
    case 'delivery_error': {
      agentdeckStore({ connectionError: message.error });
      break;
    }
    case 'connection': {
      const { connection, error } = message;
      agentdeckStore({
        connection,
        connectionError: connection === 'connected' ? '' : error || agentdeckStore.connectionError,
      });
      if (connection === 'connected') {
        void refreshSessions();
      }
      break;
    }
    case 'session_event': {
      applySessionEvent(message.sessionId, message.event);
      break;
    }
    case 'session_ended': {
      endSession(message.sessionId);
      break;
    }
  }
};

export const startApp = () => {
  let resetWasPending = false;
  try {
    if (sessionStorage.getItem(RESET_PENDING_KEY)) {
      resetWasPending = true;
      // Clear after reload: callbacks in the old document can no longer refill the outbox.
      clearTransportStorage();
      void clearAllInFlight();
      sessionStorage.removeItem(RESET_PENDING_KEY);
    }
  } catch (error) {
    agentdeckStore({
      connection: 'disconnected',
      sessionsLoaded: true,
      sessionsError: getStringFromTemplate(
        i18n.get('error.resetLocalFailed', error instanceof Error ? error.message : String(error)),
      ),
    });
    return;
  }

  const restoreInFlights = getAllInFlight()
    .then((inFlights) => {
      if (!inFlights.length) return;
      const messagesBySession = { ...agentdeckStore.messagesBySession };
      const optionsBySession = { ...agentdeckStore.optionsBySession };
      const pendingSessionIds = [...agentdeckStore.pendingSessionIds];
      const loadedSessionIds = [...agentdeckStore.loadedSessionIds];
      const currentSessions = [...agentdeckStore.sessions];

      for (const item of inFlights) {
        messagesBySession[item.sessionId] = item.messages;
        if (item.options) optionsBySession[item.sessionId] = item.options;
        if (!pendingSessionIds.includes(item.sessionId)) pendingSessionIds.push(item.sessionId);
        if (!loadedSessionIds.includes(item.sessionId)) loadedSessionIds.push(item.sessionId);
        if (!currentSessions.some((s) => s.sessionId === item.sessionId)) {
          currentSessions.unshift(item.session);
        }
        resumeInFlightTurn(item);
      }

      agentdeckStore({
        messagesBySession,
        optionsBySession,
        pendingSessionIds,
        loadedSessionIds,
        sessions: currentSessions,
        sessionGroups: getSortedSessionGroups(currentSessions, agentdeckStore.sessionGroups),
      });
    })
    .catch((error) => {
      console.error('Failed to restore in-flight sessions:', error);
    });

  const shouldAckHead = resetWasPending || !hasActiveInFlightMarker();
  initTransport({
    initialRelayId: agentdeckStore.settings.relayId,
    ackHead: shouldAckHead,
    onRequestPermission: (request) => {
      const session = getSession(request.sessionId);
      if (session?.agent !== request.agent || !agentdeckStore.pendingSessionIds.includes(request.sessionId)) {
        return Promise.reject(new Error(i18n.get('error.permissionTaskExpired')));
      }
      return requestTurnPermission(request, (req) => {
        agentdeckStore({
          permissionsBySession: { ...agentdeckStore.permissionsBySession, [req.sessionId]: req },
        });
      });
    },
    onMessage: handleTransportMessage,
    onBeforePayload: () => restoreInFlights,
  });
};

export const saveSettings = (settings: AppSettings) => {
  const next = { relayId: settings.relayId.trim(), agent: settings.agent.trim() };
  if (!isPairingId(next.relayId)) throw new Error(i18n.get('error.invalidRelayId'));
  if (!next.agent) throw new Error(i18n.get('error.selectRemoteAgent'));
  const relayChanged = next.relayId !== agentdeckStore.settings.relayId;
  const agentChanged = next.agent !== agentdeckStore.settings.agent;
  const notConnected = agentdeckStore.connection !== 'connected';
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  agentdeckStore({ settings: next, connectionError: '' });
  if (relayChanged || agentChanged) {
    resetRemoteState();
  }
  if (relayChanged) startTransport(next.relayId, { ackHead: true });
  else if (notConnected) startTransport(next.relayId);
  else if (agentChanged && agentdeckStore.connection === 'connected') void refreshSessions();
};

/**
 * 重载整个 App，结束旧文档中的连接、回调、权限等待和 Stack 页面。
 * 配对设置保留，Relay 缓存和未决会话在重新启动时清除；不等待远端取消或关闭。
 */
export const hardResetApp = () => {
  sessionStorage.setItem(RESET_PENDING_KEY, 'true');
  window.location.reload();
};
