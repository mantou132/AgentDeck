import { isRelayId } from 'relay-client-ts';
import { clearTransportStorage, initTransport, startTransport, type TransportMessage } from '../agent/transport';
import { type AppSettings, RESET_PENDING_KEY, SETTINGS_KEY } from '../config';
import { requestPermission as requestTurnPermission } from '../session/turn';
import { applySessionEvent, endSession, getSession, refreshSessions, resetRemoteState } from './sessions';
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
  try {
    if (sessionStorage.getItem(RESET_PENDING_KEY)) {
      // Clear after reload: callbacks in the old document can no longer refill the outbox.
      clearTransportStorage();
      sessionStorage.removeItem(RESET_PENDING_KEY);
    }
  } catch (error) {
    agentdeckStore({
      connection: 'disconnected',
      sessionsLoaded: true,
      sessionsError: `重置本地连接失败：${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  initTransport({
    initialRelayId: agentdeckStore.settings.relayId,
    onRequestPermission: (request) => {
      const session = getSession(request.sessionId);
      if (session?.agent !== request.agent || !agentdeckStore.pendingSessionIds.includes(request.sessionId)) {
        return Promise.reject(new Error('权限请求对应的任务已失效'));
      }
      return requestTurnPermission(request, (req) => {
        agentdeckStore({
          permissionsBySession: { ...agentdeckStore.permissionsBySession, [req.sessionId]: req },
        });
      });
    },
    onMessage: handleTransportMessage,
  });
};

export const saveSettings = (settings: AppSettings) => {
  const next = { relayId: settings.relayId.trim(), agent: settings.agent.trim() };
  if (!isRelayId(next.relayId)) throw new Error('请输入有效的 Relay UUID');
  if (!next.agent) throw new Error('请选择远端 Agent');
  const relayChanged = next.relayId !== agentdeckStore.settings.relayId;
  const agentChanged = next.agent !== agentdeckStore.settings.agent;
  const notConnected = agentdeckStore.connection !== 'connected';
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  agentdeckStore({ settings: next, connectionError: '' });
  if (relayChanged || agentChanged) {
    resetRemoteState();
  }
  if (relayChanged || notConnected) startTransport(next.relayId);
  else if (agentChanged && agentdeckStore.connection === 'connected') void refreshSessions();
};

/**
 * 重载整个 App，结束旧文档中的连接、回调、权限等待和 Stack 页面。
 * 配对设置保留，Relay 缓存在新文档启动时清除；不等待远端取消或关闭。
 */
export const hardResetApp = () => {
  sessionStorage.setItem(RESET_PENDING_KEY, 'true');
  window.location.reload();
};
