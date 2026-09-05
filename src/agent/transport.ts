import {
  DEFAULT_STORAGE_KEY,
  isRelayId,
  localStorageStore,
  RelayClient,
  type RelayConnectionState,
  type RelayStore,
} from 'relay-client-ts';
import { DEVICE_ID_KEY, RELAY_URL } from '../config';
import { AgentApi, type PermissionRequest, type SessionEvent } from './api';
import type { RpcId, RpcMessage } from './rpc';

export type ConnectionState = RelayConnectionState | 'attaching' | 'unavailable';
export const connectionLabels: Record<ConnectionState, string> = {
  connecting: '正在连接 Relay',
  connected: '远端已连接',
  attaching: 'Relay 已连接，正在连接远端',
  unavailable: '远端未响应',
  reconnecting: '正在重新连接',
  disconnected: '尚未连接',
  preempted: '连接已被取代',
};

export const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

let currentPeerId: number | undefined;
export const getPeerId = () => currentPeerId;
let relayClient: RelayClient | undefined;
let relayStore: RelayStore | undefined;
let currentRelayId = '';
let connectionState: ConnectionState = 'disconnected';
let relayConnected = false;
let attachVersion = 0;
let attachId: RpcId | undefined;
let attaching: Promise<void> | undefined;
let connectTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export const agentApi = new AgentApi(
  async (message) => {
    if (!relayClient) throw new Error('Relay 尚未配置');
    if (message.method && message.method !== 'peer_attach' && connectionState !== 'connected') {
      throw new Error('远端尚未连接，请重新连接后重试');
    }
    if (message.method === 'peer_attach') attachId = message.id;
    if (currentPeerId !== undefined) (message as Record<string, unknown>).peerId = currentPeerId;
    const client = relayClient;
    try {
      await client.send(message);
    } catch (error) {
      if (!message.method && relayClient === client) reportReplyFailure();
      throw error;
    }
  },
  async (id) => {
    // Withdraw an expired request still in our outbox. Delivery already accepted
    // by Relay cannot be undone; never automatically retry a prompt/create.
    const store = relayStore;
    if (!store) return;
    for (const message of await store.outbox()) {
      if (store !== relayStore) return;
      const payload = message.payload as RpcMessage;
      if (payload?.id === id && payload.method) await store.removeFromOutbox(message.messageId);
    }
  },
);

export type TransportMessage =
  | { type: 'connection'; connection: ConnectionState; error?: string }
  | { type: 'delivery_error'; error: string }
  | { type: 'session_event'; sessionId: string; event: SessionEvent }
  | { type: 'session_ended'; sessionId: string };

type MessageHandler = (message: TransportMessage) => void;
let globalMessageHandler: MessageHandler | undefined;
const reportReplyFailure = () =>
  globalMessageHandler?.({
    type: 'delivery_error',
    error: '操作回复未能送达远端，请在设置中重置 App 后重新加载会话。',
  });
const emitConnection = (connection: ConnectionState, error = '') => {
  connectionState = connection;
  globalMessageHandler?.({ type: 'connection', connection, error });
};

const invalidateAttach = () => {
  attachVersion++;
  attaching = undefined;
  attachId = undefined;
};

export const syncHostConnection = () => {
  if (!relayConnected) return Promise.resolve();
  if (attaching) return attaching;
  const version = ++attachVersion;
  emitConnection('attaching');
  attaching = agentApi
    .attachPeer(getDeviceId())
    .then((result) => {
      if (version !== attachVersion) return;
      if (!Number.isSafeInteger(result?.peerId) || result.peerId <= 0) {
        throw new Error('远端未返回有效的设备标识，请重新连接');
      }
      currentPeerId = result.peerId;
      emitConnection('connected');
    })
    .catch((error) => {
      if (version === attachVersion)
        emitConnection('unavailable', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      if (version === attachVersion) {
        attaching = undefined;
        attachId = undefined;
      }
    });
  return attaching;
};

export const startTransport = (relayId: string) => {
  if (!isRelayId(relayId)) return;
  if (relayClient && currentRelayId === relayId) {
    reconnectTransport(true);
    return;
  }
  closeTransport();
  currentRelayId = relayId;
  const persistedStore = localStorageStore(relayId);
  const deliveries = new Map<string, Pick<RpcMessage, 'id' | 'method'>>();
  const store: RelayStore = {
    ...persistedStore,
    outbox: () => (relayStore === store ? persistedStore.outbox() : []),
    enqueue: async (message) => {
      if (relayStore !== store) return;
      // Match Relay's full WebSocket message limit, including the envelope.
      const frame = JSON.stringify({ type: 'message', message_id: message.messageId, payload: message.payload });
      if (new TextEncoder().encode(frame).byteLength > 10 * 1024 * 1024) {
        throw new Error('消息过大，未发送。请减少文字或附件后重试。');
      }
      try {
        await persistedStore.enqueue(message);
      } catch {
        throw new Error('无法保存待发送消息，未发送。请释放本地存储空间后重试。');
      }
      if (relayStore !== store) return;
      const { id, method } = message.payload as RpcMessage;
      deliveries.set(message.messageId, { id, method });
    },
    markReceived: (sequence) => {
      if (relayStore === store) return persistedStore.markReceived(sequence);
    },
    removeFromOutbox: async (id) => {
      if (relayStore !== store) return;
      await persistedStore.removeFromOutbox(id);
      deliveries.delete(id);
    },
  };
  relayStore = store;
  const client = new RelayClient({
    relayId,
    endpoint: '2',
    deviceId: getDeviceId(),
    relayUrl: RELAY_URL,
    // Only a fresh document/pairing abandons the old server backlog.
    ackHead: true,
    store,
    onMessageRejected: (messageId, reason) => {
      if (relayClient !== client) return;
      const delivery = deliveries.get(messageId);
      if (!delivery) return;
      if (delivery.id !== undefined && delivery.method) {
        const error = reason.startsWith('queue_full:')
          ? 'Relay 待投递队列已满，消息未发送。请稍后重试。'
          : 'Relay 拒绝了这条消息，未发送。请稍后重试；持续失败可在设置中重置 App。';
        agentApi.dispatch({ id: delivery.id, error });
      } else {
        reportReplyFailure();
      }
    },
    onPayload: (payload) => {
      if (relayClient !== client) return;
      const data = payload as Record<string, unknown>;
      // An attach response may assign a new peer ID after host recovery.
      const attachResponse = attachId !== undefined && data?.id === attachId;
      if (
        !attachResponse &&
        typeof data?.peerId === 'number' &&
        currentPeerId !== undefined &&
        data.peerId !== currentPeerId
      )
        return;
      agentApi.dispatch(payload as RpcMessage);
    },
    onStateChange: (connection, error = '') => {
      if (relayClient !== client) return;
      clearTimeout(connectTimer);
      if (connection === 'connected') {
        relayConnected = true;
        void syncHostConnection();
        return;
      }
      relayConnected = false;
      invalidateAttach();
      if (connection === 'preempted') {
        clearTimeout(retryTimer);
        currentPeerId = undefined;
        agentApi.rejectAll(new Error('Relay 连接已被抢占，请重新连接或重置 App'));
      }
      emitConnection(connection, error);
      if (connection === 'connecting') {
        connectTimer = setTimeout(() => {
          if (relayClient !== client || relayConnected) return;
          client.close();
          emitConnection('reconnecting', '连接 Relay 超时，请检查网络或重新连接。');
          scheduleRetry();
        }, 10_000);
      }
    },
  });
  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (relayClient === client) void client.connect({ ackHead: false });
    }, 3000);
  };
  const rawConnect = client.connect.bind(client);
  client.connect = async (options?: { ackHead?: boolean }) => {
    if (relayClient !== client) return;
    clearTimeout(retryTimer);
    try {
      await rawConnect(options);
    } catch (error) {
      if (relayClient !== client) return;
      clearTimeout(connectTimer);
      emitConnection('reconnecting', error instanceof Error ? error.message : String(error));
      scheduleRetry();
    }
  };
  relayClient = client;
  void client.connect();
};

export const reconnectTransport = (force = false) => {
  if (!relayClient) {
    if (isRelayId(currentRelayId)) startTransport(currentRelayId);
    return;
  }
  // Reuse the SDK's receive chain, outbox and peer. Replacing only the socket
  // also repairs half-open connections without dropping missed replies.
  if (force) relayClient.close();
  void relayClient.connect({ ackHead: false });
};

// Called in a fresh document, before any RelayClient can read or write its store.
export const clearTransportStorage = () => localStorage.removeItem(DEFAULT_STORAGE_KEY);

export const closeTransport = () => {
  const previous = relayClient;
  relayClient = undefined;
  relayStore = undefined;
  relayConnected = false;
  currentPeerId = undefined;
  invalidateAttach();
  clearTimeout(connectTimer);
  clearTimeout(retryTimer);
  previous?.close();
  agentApi.rejectAll(new Error('Relay 连接已关闭'));
  emitConnection('disconnected');
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
  agentApi.setSessionEndedHandler(({ sessionId }) => globalMessageHandler?.({ type: 'session_ended', sessionId }));
  agentApi.setHostReconnectedHandler(() => syncHostConnection());
  if (isRelayId(options.initialRelayId)) startTransport(options.initialRelayId);
};
