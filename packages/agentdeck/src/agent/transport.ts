import {
  DEFAULT_STORAGE_KEY,
  localStorageStore,
  type OutboundMessage,
  RelayClient,
  type RelayConnectionState,
  type RelayStore,
} from 'relay-client-ts';
import { DEVICE_ID_KEY, RELAY_URL } from '../config';
import { getConnectionLabel, i18n } from '../i18n';
import { AgentApi, type PermissionRequest, type SessionEvent } from './api';
import { createRelayEncryption, isPairingId, type RelayEncryption } from './encryption';
import type { RpcId, RpcMessage } from './rpc';

type HostSyncOptions = {
  metadataOnly: boolean;
  deviceId: string;
  agentApi: AgentApi;
  onStateChange: (state: ConnectionState, error?: string) => void;
  onSynced?: (sentToken: string | null | undefined) => void;
};

type InitTransportOptions = {
  initialRelayId: string;
  onRequestPermission: (request: PermissionRequest) => Promise<string>;
  onMessage: MessageHandler;
  onBeforePayload?: () => Promise<unknown> | undefined;
  ackHead?: boolean;
};

export type ConnectionState = RelayConnectionState | 'attaching' | 'unavailable';
export const connectionLabels = new Proxy({} as Record<ConnectionState, string>, {
  get: (_, prop: ConnectionState) => getConnectionLabel(prop),
});

export type TransportMessage =
  | { type: 'connection'; connection: ConnectionState; error?: string }
  | { type: 'delivery_error'; error: string }
  | { type: 'session_event'; sessionId: string; event: SessionEvent }
  | { type: 'session_ended'; sessionId: string };

type MessageHandler = (message: TransportMessage) => void;

export type TransportOptions = {
  ackHead?: boolean;
  relayUrl?: string;
  createStore?: (routeId: string) => RelayStore;
  deviceId?: string;
};

// ---------------------------------------------------------------------------
// 1. Encrypted Storage Layer
// ---------------------------------------------------------------------------

/** Wraps a RelayStore with transparent ChaCha20-Poly1305 encryption & RPC tracking. */
class EncryptedRelayStore implements RelayStore {
  #active = true;
  #baseStore: RelayStore;
  #encryption: RelayEncryption | undefined;
  #deliveries = new Map<string, Pick<RpcMessage, 'id' | 'method'>>();

  constructor(baseStore: RelayStore, encryption: RelayEncryption | undefined) {
    this.#baseStore = baseStore;
    this.#encryption = encryption;
  }

  dispose(): void {
    this.#active = false;
  }

  async outbox(): Promise<OutboundMessage[]> {
    if (!this.#active) return [];
    const messages = await this.#baseStore.outbox();
    for (const message of messages) {
      if (this.#deliveries.has(message.messageId)) continue;
      const payload = (
        this.#encryption ? this.#encryption.readOutgoing(message.payload) : message.payload
      ) as RpcMessage;
      this.#deliveries.set(message.messageId, { id: payload?.id, method: payload?.method });
    }
    return messages;
  }

  async enqueue(message: OutboundMessage): Promise<void> {
    if (!this.#active) return;
    const { id, method } = message.payload as RpcMessage;
    let payload: unknown;
    try {
      payload = this.#encryption ? this.#encryption.seal(message.payload) : message.payload;
    } catch {
      throw new Error(i18n.get('error.encryptionFailed'));
    }

    // Match Relay's full WebSocket message limit, including the envelope.
    const frame = JSON.stringify({ type: 'message', message_id: message.messageId, payload });
    if (new TextEncoder().encode(frame).byteLength > 10 * 1024 * 1024) {
      throw new Error(i18n.get('error.messageTooLarge'));
    }

    try {
      await this.#baseStore.enqueue({ ...message, payload });
    } catch {
      throw new Error(i18n.get('error.storageFailed'));
    }

    if (!this.#active) return;
    this.#deliveries.set(message.messageId, { id, method });
  }

  lastReceived(): number | undefined | Promise<number | undefined> {
    return this.#baseStore.lastReceived();
  }

  markReceived(sequence: number): void | Promise<void> {
    if (this.#active) return this.#baseStore.markReceived(sequence);
  }

  async removeFromOutbox(messageId: string): Promise<void> {
    if (!this.#active) return;
    await this.#baseStore.removeFromOutbox(messageId);
    this.#deliveries.delete(messageId);
  }

  deviceId(): string | undefined | Promise<string | undefined> {
    return this.#baseStore.deviceId?.();
  }

  getDelivery(messageId: string): Pick<RpcMessage, 'id' | 'method'> | undefined {
    return this.#deliveries.get(messageId);
  }

  async withdrawRpc(id: RpcId): Promise<void> {
    if (!this.#active) return;
    for (const message of await this.#baseStore.outbox()) {
      if (!this.#active) return;
      const payload = (
        this.#encryption ? this.#encryption.readOutgoing(message.payload) : message.payload
      ) as RpcMessage;
      if (payload?.id === id && payload?.method) {
        await this.removeFromOutbox(message.messageId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Host Session Manager (peer_attach & push token state machine)
// ---------------------------------------------------------------------------

class HostSessionManager {
  #peerId: number | undefined;
  #attachId: RpcId | undefined;
  #attaching: Promise<void> | undefined;
  #fcmToken: string | null | undefined;
  #syncedFcmToken: string | null | undefined;
  #attachVersion = 0;

  get peerId() {
    return this.#peerId;
  }

  set peerId(id: number | undefined) {
    this.#peerId = id;
  }

  get attachId() {
    return this.#attachId;
  }

  set attachId(id: RpcId | undefined) {
    this.#attachId = id;
  }

  get attaching() {
    return this.#attaching;
  }

  get fcmToken() {
    return this.#fcmToken;
  }

  invalidate(): void {
    this.#attachVersion++;
    this.#attaching = undefined;
    this.#attachId = undefined;
  }

  reset(): void {
    this.#peerId = undefined;
    this.invalidate();
  }

  updateFcmToken(token: string | null, onTokenNeedsSync: () => void): void {
    this.#fcmToken = token;
    if (token !== this.#syncedFcmToken) {
      onTokenNeedsSync();
    }
  }

  sync(options: HostSyncOptions): Promise<void> {
    if (this.#attaching) return this.#attaching;

    const version = ++this.#attachVersion;
    const silent = options.metadataOnly;
    const sentToken = this.#fcmToken;

    if (!silent) options.onStateChange('attaching');

    this.#attaching = options.agentApi
      .attachPeer(options.deviceId, sentToken)
      .then((result) => {
        if (version !== this.#attachVersion) return;
        if (!Number.isSafeInteger(result?.peerId) || result.peerId <= 0) {
          throw new Error(i18n.get('error.invalidDeviceId'));
        }
        const peerChanged = this.#peerId !== result.peerId;
        this.#peerId = result.peerId;
        this.#syncedFcmToken = sentToken;
        if (!silent || peerChanged) options.onStateChange('connected');
      })
      .catch((error) => {
        if (version !== this.#attachVersion) return;
        if (silent) console.error('Failed to synchronize push registration:', error);
        else options.onStateChange('unavailable', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (version === this.#attachVersion) {
          this.#attaching = undefined;
          this.#attachId = undefined;
          options.onSynced?.(sentToken);
        }
      });

    return this.#attaching;
  }

  isPayloadAllowed(data: Record<string, unknown>): boolean {
    const isAttachResponse = this.#attachId !== undefined && data?.id === this.#attachId;
    if (
      !isAttachResponse &&
      typeof data?.peerId === 'number' &&
      this.#peerId !== undefined &&
      data.peerId !== this.#peerId
    ) {
      return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// 3. Transport Orchestrator
// ---------------------------------------------------------------------------

class AgentTransport {
  readonly agentApi: AgentApi;
  readonly hostSession = new HostSessionManager();

  #messageHandlers = new Set<MessageHandler>();
  #connectionState: ConnectionState = 'disconnected';
  #currentRelayId = '';
  #currentDeviceId: string | undefined;
  #currentOptions: TransportOptions | undefined;
  #relayConnected = false;

  #relayClient: RelayClient | undefined;
  #encryptedStore: EncryptedRelayStore | undefined;
  #encryption: RelayEncryption | undefined;

  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #beforePayloadHook: (() => Promise<unknown> | undefined) | undefined;

  constructor() {
    this.agentApi = new AgentApi(
      async (message) => {
        if (!this.#relayClient) throw new Error(i18n.get('error.relayNotConfigured'));
        if (message.method && message.method !== 'peer_attach' && this.#connectionState !== 'connected') {
          throw new Error(i18n.get('error.remoteNotConnectedRetry'));
        }
        if (message.method === 'peer_attach') {
          this.hostSession.attachId = message.id;
        }
        if (this.hostSession.peerId !== undefined) {
          (message as Record<string, unknown>).peerId = this.hostSession.peerId;
        }
        const client = this.#relayClient;
        try {
          await client.send(message);
        } catch (error) {
          if (!message.method && this.#relayClient === client) this.#reportReplyFailure();
          throw error;
        }
      },
      async (id) => {
        await this.#encryptedStore?.withdrawRpc(id);
      },
    );
  }

  getDeviceId(): string {
    if (this.#currentDeviceId) return this.#currentDeviceId;
    if (typeof localStorage !== 'undefined') {
      let id = localStorage.getItem(DEVICE_ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(DEVICE_ID_KEY, id);
      }
      return id;
    }
    return crypto.randomUUID();
  }

  addMessageHandler(handler: MessageHandler): () => void {
    this.#messageHandlers.add(handler);
    return () => {
      this.#messageHandlers.delete(handler);
    };
  }

  setBeforePayloadHook(hook: (() => Promise<unknown> | undefined) | undefined) {
    this.#beforePayloadHook = hook;
  }

  dispatchMessage(message: TransportMessage) {
    for (const handler of this.#messageHandlers) handler(message);
  }

  #emitConnection(connection: ConnectionState, error = '') {
    this.#connectionState = connection;
    this.dispatchMessage({ type: 'connection', connection, error });
  }

  #reportReplyFailure() {
    this.dispatchMessage({
      type: 'delivery_error',
      error: i18n.get('error.deliveryReplyFailed'),
    });
  }

  updateFcmToken(token: string | null) {
    this.hostSession.updateFcmToken(token, () => {
      if (this.#connectionState === 'connected') this.syncHostConnection(true);
    });
  }

  syncHostConnection(metadataOnly = false): Promise<void> {
    if (!this.#relayConnected) return Promise.resolve();
    if (this.hostSession.attaching) return this.hostSession.attaching;
    return this.hostSession.sync({
      metadataOnly: metadataOnly && this.#connectionState === 'connected',
      deviceId: this.getDeviceId(),
      agentApi: this.agentApi,
      onStateChange: (state, error) => this.#emitConnection(state, error),
      onSynced: (sentToken) => {
        if (this.#connectionState === 'connected' && this.hostSession.fcmToken !== sentToken) {
          this.syncHostConnection(true);
        }
      },
    });
  }

  start(relayId: string, options?: TransportOptions) {
    if (!isPairingId(relayId)) return;
    if (this.#relayClient && this.#currentRelayId === relayId) {
      this.reconnect(true);
      return;
    }
    this.close();

    this.#currentRelayId = relayId;
    this.#currentOptions = options;
    this.#currentDeviceId = options?.deviceId;

    const deviceId = this.getDeviceId();
    const encryption = createRelayEncryption(relayId, deviceId);
    this.#encryption = encryption;
    const routeId = encryption?.routeId ?? relayId;

    const baseStore = options?.createStore ? options.createStore(routeId) : localStorageStore(routeId);
    const store = new EncryptedRelayStore(baseStore, encryption);
    this.#encryptedStore = store;

    const client = new RelayClient({
      relayId: routeId,
      endpoint: '2',
      deviceId,
      relayUrl: options?.relayUrl || RELAY_URL,
      ackHead: options?.ackHead ?? false,
      store,
      onMessageRejected: (messageId, reason) => {
        if (this.#relayClient !== client) return;
        const delivery = store.getDelivery(messageId);
        if (!delivery) return;
        if (delivery.id !== undefined && delivery.method) {
          const error = reason.startsWith('queue_full:')
            ? i18n.get('error.relayQueueFull')
            : i18n.get('error.relayRejected');
          this.agentApi.dispatch({ id: delivery.id, error });
        } else {
          this.#reportReplyFailure();
        }
      },
      onPayload: async (payload) => {
        if (this.#relayClient !== client) return;
        if (encryption) {
          try {
            payload = encryption.open(payload).message;
          } catch {
            throw new Error(i18n.get('error.decryptionFailed'));
          }
        }
        if (this.#beforePayloadHook) {
          try {
            await this.#beforePayloadHook();
          } catch {}
        }
        const data = payload as Record<string, unknown>;
        if (!this.hostSession.isPayloadAllowed(data)) return;
        await this.agentApi.dispatch(payload as RpcMessage);
      },
      onStateChange: (connection, error = '') => {
        if (this.#relayClient !== client) return;
        clearTimeout(this.#connectTimer);
        if (connection === 'connected') {
          this.#relayConnected = true;
          this.syncHostConnection();
          return;
        }
        this.#relayConnected = false;
        this.hostSession.invalidate();
        if (connection === 'preempted') {
          clearTimeout(this.#retryTimer);
          this.hostSession.peerId = undefined;
          this.agentApi.rejectAll(new Error(i18n.get('error.relayPreempted')));
        }
        this.#emitConnection(connection, error || (connection === 'preempted' ? i18n.get('error.relayPreempted') : ''));
        if (connection === 'connecting') {
          this.#connectTimer = setTimeout(() => {
            if (this.#relayClient !== client || this.#relayConnected) return;
            client.close();
            this.#emitConnection('reconnecting', i18n.get('error.relayTimeout'));
            this.#scheduleRetry(client, relayId);
          }, 10_000);
        }
      },
    });

    const rawConnect = client.connect.bind(client);
    client.connect = async (connectOptions?: { ackHead?: boolean }) => {
      clearTimeout(this.#retryTimer);
      try {
        await rawConnect(connectOptions);
      } catch (error) {
        if (this.#relayClient !== client) return;
        clearTimeout(this.#connectTimer);
        this.#emitConnection('reconnecting', error instanceof Error ? error.message : String(error));
        this.#scheduleRetry(client, relayId);
      }
    };

    this.#relayClient = client;
    client.connect({ ackHead: options?.ackHead });
  }

  #scheduleRetry(client: RelayClient, relayId: string) {
    clearTimeout(this.#retryTimer);
    if (!this.#relayClient || this.#currentRelayId !== relayId) return;
    this.#retryTimer = setTimeout(() => {
      if (this.#relayClient === client) client.connect({ ackHead: false });
    }, 3000);
  }

  reconnect(force = false) {
    if (!this.#relayClient) {
      if (isPairingId(this.#currentRelayId)) this.start(this.#currentRelayId, this.#currentOptions);
      return;
    }
    if (force) this.#relayClient.close();
    this.#relayClient.connect({ ackHead: false });
  }

  close() {
    const previous = this.#relayClient;
    this.#relayClient = undefined;
    this.#encryptedStore?.dispose();
    this.#encryptedStore = undefined;
    this.#encryption = undefined;
    this.#relayConnected = false;
    this.#currentDeviceId = undefined;
    this.hostSession.reset();
    clearTimeout(this.#connectTimer);
    clearTimeout(this.#retryTimer);
    previous?.close();
    this.agentApi.rejectAll(new Error(i18n.get('error.relayClosed')));
    this.#emitConnection('disconnected');
  }
}

// ---------------------------------------------------------------------------
// 4. Singleton Facade Exports (100% Backwards Compatible)
// ---------------------------------------------------------------------------

const transport = new AgentTransport();

export const agentApi = transport.agentApi;
export const getDeviceId = () => transport.getDeviceId();
export const getPeerId = () => transport.hostSession.peerId;
export const addTransportMessageHandler = (handler: MessageHandler) => transport.addMessageHandler(handler);
export const updateFcmToken = (token: string | null) => transport.updateFcmToken(token);
export const syncHostConnection = (metadataOnly = false) => transport.syncHostConnection(metadataOnly);
export const startTransport = (relayId: string, options?: TransportOptions) => transport.start(relayId, options);
export const reconnectTransport = (force = false) => transport.reconnect(force);
export const closeTransport = () => transport.close();
export const clearTransportStorage = () => localStorage.removeItem(DEFAULT_STORAGE_KEY);

let transportInitialized = false;
export const initTransport = (options: InitTransportOptions) => {
  transport.addMessageHandler(options.onMessage);
  transport.setBeforePayloadHook(options.onBeforePayload);
  if (transportInitialized) return;
  transportInitialized = true;
  agentApi.setPermissionHandler(options.onRequestPermission);
  agentApi.setSessionEndedHandler(({ sessionId }) => transport.dispatchMessage({ type: 'session_ended', sessionId }));
  agentApi.setHostReconnectedHandler(() => syncHostConnection());
  if (isPairingId(options.initialRelayId)) startTransport(options.initialRelayId, { ackHead: options.ackHead });
};
