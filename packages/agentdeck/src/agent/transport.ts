import {
  DEFAULT_STORAGE_KEY,
  localStorageStore,
  RelayClient,
  type RelayConnectionState,
  type RelayStore,
} from 'relay-client-ts';
import { DEVICE_ID_KEY, RELAY_URL } from '../config';
import { getConnectionLabel, i18n } from '../i18n';
import { AgentApi, type PermissionRequest, type SessionEvent } from './api';
import { createRelayEncryption, isPairingId, type RelayEncryption } from './encryption';
import type { RpcId, RpcMessage } from './rpc';

export type ConnectionState = RelayConnectionState | 'attaching' | 'unavailable';
export const connectionLabels = new Proxy({} as Record<ConnectionState, string>, {
  get: (_, prop: ConnectionState) => getConnectionLabel(prop),
});

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
let relayEncryption: RelayEncryption | undefined;
let currentRelayId = '';
let connectionState: ConnectionState = 'disconnected';
let relayConnected = false;
let attachVersion = 0;
let attachId: RpcId | undefined;
let attaching: Promise<void> | undefined;
let fcmToken: string | null | undefined;
let syncedFcmToken: string | null | undefined;
let connectTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export const agentApi = new AgentApi(
  async (message) => {
    if (!relayClient) throw new Error(i18n.get('error.relayNotConfigured'));
    if (message.method && message.method !== 'peer_attach' && connectionState !== 'connected') {
      throw new Error(i18n.get('error.remoteNotConnectedRetry'));
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
      const payload = (relayEncryption ? relayEncryption.readOutgoing(message.payload) : message.payload) as RpcMessage;
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
let beforePayloadHook: (() => Promise<unknown> | undefined) | undefined;

const reportReplyFailure = () =>
  globalMessageHandler?.({
    type: 'delivery_error',
    error: i18n.get('error.deliveryReplyFailed'),
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

export const updateFcmToken = (token: string | null) => {
  fcmToken = token;
  if (connectionState === 'connected' && token !== syncedFcmToken) void syncHostConnection(true);
};

export const syncHostConnection = (metadataOnly = false) => {
  if (!relayConnected) return Promise.resolve();
  if (attaching) return attaching;
  const version = ++attachVersion;
  const silent = metadataOnly && connectionState === 'connected';
  const sentToken = fcmToken;
  if (!silent) emitConnection('attaching');
  attaching = agentApi
    .attachPeer(getDeviceId(), sentToken)
    .then((result) => {
      if (version !== attachVersion) return;
      if (!Number.isSafeInteger(result?.peerId) || result.peerId <= 0) {
        throw new Error(i18n.get('error.invalidDeviceId'));
      }
      const peerChanged = currentPeerId !== result.peerId;
      currentPeerId = result.peerId;
      syncedFcmToken = sentToken;
      if (!silent || peerChanged) emitConnection('connected');
    })
    .catch((error) => {
      if (version !== attachVersion) return;
      if (silent) console.error('Failed to synchronize push registration:', error);
      else emitConnection('unavailable', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      if (version === attachVersion) {
        attaching = undefined;
        attachId = undefined;
        // A token can arrive or rotate while the initial handshake is pending.
        if (connectionState === 'connected' && fcmToken !== sentToken) void syncHostConnection(true);
      }
    });
  return attaching;
};

export const startTransport = (relayId: string, options?: { ackHead?: boolean }) => {
  if (!isPairingId(relayId)) return;
  if (relayClient && currentRelayId === relayId) {
    reconnectTransport(true);
    return;
  }
  closeTransport();
  currentRelayId = relayId;
  const encryption = createRelayEncryption(relayId, getDeviceId());
  relayEncryption = encryption;
  const routeId = encryption?.routeId ?? relayId;
  const persistedStore = localStorageStore(routeId);
  const deliveries = new Map<string, Pick<RpcMessage, 'id' | 'method'>>();
  const store: RelayStore = {
    ...persistedStore,
    outbox: async () => {
      if (relayStore !== store) return [];
      const messages = await persistedStore.outbox();
      for (const message of messages) {
        if (deliveries.has(message.messageId)) continue;
        const { id, method } = (encryption ? encryption.readOutgoing(message.payload) : message.payload) as RpcMessage;
        deliveries.set(message.messageId, { id, method });
      }
      return messages;
    },
    enqueue: async (message) => {
      if (relayStore !== store) return;
      const { id, method } = message.payload as RpcMessage;
      let payload: unknown;
      try {
        payload = encryption ? encryption.seal(message.payload) : message.payload;
      } catch {
        throw new Error(i18n.get('error.encryptionFailed'));
      }
      // Match Relay's full WebSocket message limit, including the envelope.
      const frame = JSON.stringify({ type: 'message', message_id: message.messageId, payload });
      if (new TextEncoder().encode(frame).byteLength > 10 * 1024 * 1024) {
        throw new Error(i18n.get('error.messageTooLarge'));
      }
      try {
        await persistedStore.enqueue({ ...message, payload });
      } catch {
        throw new Error(i18n.get('error.storageFailed'));
      }
      if (relayStore !== store) return;
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
    relayId: routeId,
    endpoint: '2',
    deviceId: getDeviceId(),
    relayUrl: RELAY_URL,
    ackHead: options?.ackHead ?? false,
    store,
    onMessageRejected: (messageId, reason) => {
      if (relayClient !== client) return;
      const delivery = deliveries.get(messageId);
      if (!delivery) return;
      if (delivery.id !== undefined && delivery.method) {
        const error = reason.startsWith('queue_full:')
          ? i18n.get('error.relayQueueFull')
          : i18n.get('error.relayRejected');
        agentApi.dispatch({ id: delivery.id, error });
      } else {
        reportReplyFailure();
      }
    },
    onPayload: async (payload) => {
      if (relayClient !== client) return;
      if (encryption) {
        try {
          payload = encryption.open(payload).message;
        } catch {
          throw new Error(i18n.get('error.decryptionFailed'));
        }
      }
      if (beforePayloadHook) {
        try {
          await beforePayloadHook();
        } catch {}
      }
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
      await agentApi.dispatch(payload as RpcMessage);
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
        agentApi.rejectAll(new Error(i18n.get('error.relayPreempted')));
      }
      emitConnection(connection, error);
      if (connection === 'connecting') {
        connectTimer = setTimeout(() => {
          if (relayClient !== client || relayConnected) return;
          client.close();
          emitConnection('reconnecting', i18n.get('error.relayTimeout'));
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
    if (isPairingId(currentRelayId)) startTransport(currentRelayId);
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
  relayEncryption = undefined;
  relayConnected = false;
  currentPeerId = undefined;
  invalidateAttach();
  clearTimeout(connectTimer);
  clearTimeout(retryTimer);
  previous?.close();
  agentApi.rejectAll(new Error(i18n.get('error.relayClosed')));
  emitConnection('disconnected');
};

let transportInitialized = false;
export const initTransport = (options: {
  initialRelayId: string;
  onRequestPermission: (request: PermissionRequest) => Promise<string>;
  onMessage: MessageHandler;
  onBeforePayload?: () => Promise<unknown> | undefined;
  ackHead?: boolean;
}) => {
  globalMessageHandler = options.onMessage;
  beforePayloadHook = options.onBeforePayload;
  if (transportInitialized) return;
  transportInitialized = true;
  agentApi.setPermissionHandler(options.onRequestPermission);
  agentApi.setSessionEndedHandler(({ sessionId }) => globalMessageHandler?.({ type: 'session_ended', sessionId }));
  agentApi.setHostReconnectedHandler(() => syncHostConnection());
  if (isPairingId(options.initialRelayId)) startTransport(options.initialRelayId, { ackHead: options.ackHead });
};
