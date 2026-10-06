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
import { AgentApi, type ClientCapabilities, type SessionEvent, type UserInput } from './api';
import { isPairingId } from './encryption';
import { RelayCodec } from './relay-codec';
import type { RpcId, RpcMessage } from './rpc';

type HostSyncOptions = {
  metadataOnly: boolean;
  deviceId: string;
  capabilities?: ClientCapabilities;
  agentApi: AgentApi;
  onStateChange: (state: ConnectionState, error?: string) => void;
  onSynced?: (sentToken: string | null | undefined) => void;
};

type InitTransportOptions = {
  initialRelayId: string;
  initialRelayUrl?: string;
  onUserInput: (input: UserInput) => void;
  onMessage: MessageHandler;
  onBeforePayload?: () => Promise<unknown> | undefined;
  ackHead?: boolean;
  capabilities?: ClientCapabilities;
};

export type ConnectionState = RelayConnectionState | 'attaching' | 'unavailable';
export const connectionLabels = new Proxy({} as Record<ConnectionState, string>, {
  get: (_, prop: ConnectionState) => getConnectionLabel(prop),
});

export type TransportMessage =
  /** `hostVersion` comes with `connected`; old hosts omit it. */
  | { type: 'connection'; connection: ConnectionState; error?: string; hostVersion?: string }
  | { type: 'delivery_error'; error: string }
  | { type: 'session_event'; sessionId: string; event: SessionEvent }
  | { type: 'session_ended'; sessionId: string }
  | { type: 'prompt_suggestion'; sessionId: string; suggestion: string };

type MessageHandler = (message: TransportMessage) => void;

export type TransportOptions = {
  ackHead?: boolean;
  relayUrl?: string;
  createStore?: (routeId: string) => RelayStore;
  deviceId?: string;
  /** Rendering capabilities declared to the host; they decide the skills loaded into sessions. */
  capabilities?: ClientCapabilities;
};

// ---------------------------------------------------------------------------
// 1. Outbox Storage Layer
// ---------------------------------------------------------------------------

/** Wraps a RelayStore so the outbox holds encoded payloads, and tracks which RPC each entry carries. */
class RpcOutboxStore implements RelayStore {
  #active = true;
  #baseStore: RelayStore;
  #codec: RelayCodec;
  #deliveries = new Map<string, Pick<RpcMessage, 'id' | 'method'>>();

  constructor(baseStore: RelayStore, codec: RelayCodec) {
    this.#baseStore = baseStore;
    this.#codec = codec;
  }

  dispose(): void {
    this.#active = false;
  }

  async outbox(): Promise<OutboundMessage[]> {
    if (!this.#active) return [];
    const messages = await this.#baseStore.outbox();
    for (const message of messages) {
      if (this.#deliveries.has(message.messageId)) continue;
      const payload = this.#codec.readOutgoing(message.payload);
      this.#deliveries.set(message.messageId, { id: payload?.id, method: payload?.method });
    }
    return messages;
  }

  async enqueue(message: OutboundMessage): Promise<void> {
    if (!this.#active) return;
    const { id, method } = message.payload as RpcMessage;
    const payload = this.#codec.encode(message.payload as RpcMessage, false, message.messageId);

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
      const payload = this.#codec.readOutgoing(message.payload);
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
  #hostVersion: string | undefined;
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

  get hostVersion() {
    return this.#hostVersion;
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
      .attachPeer(options.deviceId, sentToken, options.capabilities)
      .then((result) => {
        if (version !== this.#attachVersion) return;
        if (!Number.isSafeInteger(result?.peerId) || result.peerId <= 0) {
          throw new Error(i18n.get('error.invalidDeviceId'));
        }
        const peerChanged = this.#peerId !== result.peerId;
        this.#peerId = result.peerId;
        this.#hostVersion = result.version;
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
  #codec: RelayCodec | undefined;
  #outboxStore: RpcOutboxStore | undefined;

  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #beforePayloadHook: (() => Promise<unknown> | undefined) | undefined;

  constructor() {
    this.agentApi = new AgentApi(
      async (message) => {
        const client = this.#relayClient;
        const codec = this.#codec;
        if (!client || !codec) throw new Error(i18n.get('error.relayNotConfigured'));
        if (message.method && message.method !== 'peer_attach' && this.#connectionState !== 'connected') {
          throw new Error(i18n.get('error.remoteNotConnectedRetry'));
        }
        if (message.method === 'peer_attach') {
          this.hostSession.attachId = message.id;
        }
        if (this.hostSession.peerId !== undefined) {
          (message as Record<string, unknown>).peerId = this.hostSession.peerId;
        }
        if (message.ephemeral && message.id !== undefined) {
          // The RPC id doubles as the Relay message id, so `onUndeliverable` names the call directly.
          const messageId = String(message.id);
          const payload = codec.encode(message, true, messageId);
          try {
            client.sendEphemeral(payload, undefined, messageId);
          } catch {
            throw new Error(i18n.get('error.remoteNotConnectedRetry'));
          }
          return;
        }
        try {
          await client.send(message);
        } catch (error) {
          if (!message.method && this.#relayClient === client) this.#reportReplyFailure();
          throw error;
        }
      },
      async (id) => {
        await this.#outboxStore?.withdrawRpc(id);
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
    const hostVersion = connection === 'connected' ? this.hostSession.hostVersion : undefined;
    this.dispatchMessage({ type: 'connection', connection, error, hostVersion });
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
      capabilities: this.#currentOptions?.capabilities,
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
    const sameRelay = (this.#currentOptions?.relayUrl || '') === (options?.relayUrl || '');
    if (this.#relayClient && this.#currentRelayId === relayId && sameRelay) {
      this.reconnect(true);
      return;
    }
    this.close();

    this.#currentRelayId = relayId;
    this.#currentOptions = options;
    this.#currentDeviceId = options?.deviceId;

    const deviceId = this.getDeviceId();
    const codec = new RelayCodec(relayId, deviceId);
    const { routeId } = codec;
    this.#codec = codec;

    const baseStore = options?.createStore ? options.createStore(routeId) : localStorageStore(routeId);
    const store = new RpcOutboxStore(baseStore, codec);
    this.#outboxStore = store;

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
      onUndeliverable: (messageId) => {
        if (this.#relayClient !== client) return;
        this.agentApi.dispatch({ id: messageId, error: i18n.get('error.remoteNotConnectedRetry') });
      },
      onPayload: async (payload) => {
        if (this.#relayClient !== client) return;
        await this.#receive(codec.decode(payload));
      },
      onBinary: async (data) => {
        if (this.#relayClient !== client) return;
        await this.#receive(codec.decodeBinary(data));
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

  async #receive(message: RpcMessage) {
    if (this.#beforePayloadHook) {
      try {
        await this.#beforePayloadHook();
      } catch {}
    }
    if (!this.hostSession.isPayloadAllowed(message as Record<string, unknown>)) return;
    await this.agentApi.dispatch(message);
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
    this.#outboxStore?.dispose();
    this.#outboxStore = undefined;
    this.#codec = undefined;
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
  agentApi.setUserInputHandler(options.onUserInput);
  agentApi.setSessionEndedHandler(({ sessionId }) => transport.dispatchMessage({ type: 'session_ended', sessionId }));
  agentApi.setPromptSuggestionHandler(({ sessionId, suggestion }) =>
    transport.dispatchMessage({ type: 'prompt_suggestion', sessionId, suggestion }),
  );
  agentApi.setHostReconnectedHandler(() => syncHostConnection());
  if (isPairingId(options.initialRelayId))
    startTransport(options.initialRelayId, {
      ackHead: options.ackHead,
      relayUrl: options.initialRelayUrl,
      capabilities: options.capabilities,
    });
};
