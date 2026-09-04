import { DEFAULT_STORAGE_KEY, isRelayId, RelayClient, type RelayConnectionState } from 'relay-client-ts';
import { AgentApi, type PermissionRequest, type SessionEvent } from './agent-api';
import { DEVICE_ID_KEY, RELAY_URL } from './session-runtime';

export const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

let currentPeerId: number | undefined;
export const setPeerId = (id: number | undefined) => {
  currentPeerId = id;
};
export const getPeerId = () => currentPeerId;

let relayClient: RelayClient | undefined;
let currentRelayId = '';

export const agentApi = new AgentApi((message) => {
  if (!relayClient) throw new Error('Relay 尚未配置');
  if (currentPeerId !== undefined) {
    (message as Record<string, unknown>).peerId = currentPeerId;
  }
  relayClient.send(message);
});

export type TransportMessage =
  | { type: 'connection'; connection: RelayConnectionState; error?: string }
  | { type: 'session_event'; sessionId: string; event: SessionEvent }
  | { type: 'session_ended'; sessionId: string }
  | { type: 'host_reconnected' };

type MessageHandler = (message: TransportMessage) => void;
let globalMessageHandler: MessageHandler | undefined;

export const startTransport = (relayId: string) => {
  if (!isRelayId(relayId)) return;
  currentRelayId = relayId;
  relayClient?.close();

  const client = new RelayClient({
    relayId,
    endpoint: '2',
    deviceId: getDeviceId(),
    relayUrl: RELAY_URL,
    ackHead: true,
    onPayload: (payload) => {
      const data = payload as Record<string, unknown>;
      if (typeof data?.peerId === 'number' && currentPeerId !== undefined) {
        if (data.peerId !== currentPeerId) {
          // Message belongs to another device on this relay; ignore.
          return;
        }
      }
      agentApi.dispatch(payload as Parameters<AgentApi['dispatch']>[0]);
    },
    onDisconnect: (_error) => {
      // 临时断线由 RelayClient 自动重连与消息序列恢复，不销毁正在执行的 Turn 与 peerId
    },
    onStateChange: (connection, connectionError = '') => {
      if (connection === 'preempted') {
        currentPeerId = undefined;
        agentApi.rejectAll(new Error('Relay 连接已被抢占'));
      }
      globalMessageHandler?.({ type: 'connection', connection, error: connectionError });
    },
  });

  // Guard against unhandled connect errors breaking the reconnection loop
  const rawConnect = client.connect.bind(client);
  client.connect = async (options?: { ackHead?: boolean }) => {
    try {
      await rawConnect(options);
    } catch (error) {
      globalMessageHandler?.({
        type: 'connection',
        connection: 'reconnecting',
        error: error instanceof Error ? error.message : String(error),
      });
      setTimeout(() => {
        void client.connect();
      }, 3000);
    }
  };

  relayClient = client;
  void relayClient.connect();
};

export const reconnectTransport = (force = false) => {
  if (force && currentRelayId && isRelayId(currentRelayId)) {
    startTransport(currentRelayId);
    return;
  }
  if (!relayClient) {
    if (currentRelayId && isRelayId(currentRelayId)) {
      startTransport(currentRelayId);
    }
    return;
  }
  void relayClient.connect();
};

export const hardResetTransport = (relayId?: string) => {
  const targetId = relayId || currentRelayId;
  relayClient?.close();
  relayClient = undefined;
  currentPeerId = undefined;
  agentApi.rejectAll(new Error('Relay 连接已重置'));
  try {
    localStorage.removeItem(DEFAULT_STORAGE_KEY);
  } catch {}
  if (targetId && isRelayId(targetId)) {
    startTransport(targetId);
  }
};

export const closeTransport = () => {
  relayClient?.close();
  relayClient = undefined;
  currentPeerId = undefined;
  agentApi.rejectAll(new Error('Relay 连接已关闭'));
};

export const syncHostConnection = async () => {
  try {
    const res = await agentApi.attachPeer(getDeviceId());
    if (typeof res?.peerId === 'number') {
      setPeerId(res.peerId);
    }
  } catch (e) {
    console.warn('Failed to attach peer ID:', e);
  }
};

let transportInitialized = false;
export const initTransport = (options: {
  initialRelayId: string;
  onRequestPermission: (request: PermissionRequest) => Promise<string>;
  onMessage: MessageHandler;
}) => {
  globalMessageHandler = options.onMessage;
  if (transportInitialized) return;
  transportInitialized = true;

  agentApi.setPermissionHandler(options.onRequestPermission);
  agentApi.setSessionEndedHandler(({ sessionId }) => {
    globalMessageHandler?.({ type: 'session_ended', sessionId });
  });
  agentApi.setHostReconnectedHandler(() => {
    globalMessageHandler?.({ type: 'host_reconnected' });
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        reconnectTransport();
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      reconnectTransport(true);
    });
  }

  if (isRelayId(options.initialRelayId)) {
    startTransport(options.initialRelayId);
  }
};
