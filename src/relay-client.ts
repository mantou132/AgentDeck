export type RelayConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'conflict';

type OutboundMessage = {
  messageId: string;
  payload: unknown;
};

type RelayState = {
  messagePrefix: string;
  nextMessage: number;
  lastReceived?: number;
  outbox: OutboundMessage[];
};

type ServerFrame =
  | { type: 'ready'; endpoint: '1' | '2' }
  | { type: 'stored'; message_id: string }
  | { type: 'message'; message_id: string; sequence: number; payload: unknown }
  | { type: 'error'; message: string };

type RelayClientOptions = {
  relayId: string;
  onPayload: (payload: unknown) => void | Promise<void>;
  onStateChange?: (state: RelayConnectionState, error?: string) => void;
  onDisconnect?: (error: Error) => void;
};

const RELAY_URL =
  process.env.NODE_ENV === 'development' ? 'ws://192.168.77.137:39371/ws' : 'wss://agent-deck.xianqiao.wang/ws';
const MIN_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;
const STORAGE_PREFIX = 'agentdeck.relay.v1.';

const storageKey = (relayId: string) => `${STORAGE_PREFIX}${relayId}`;

const createState = (): RelayState => ({
  messagePrefix: crypto.randomUUID(),
  nextMessage: 0,
  outbox: [],
});

const readState = (relayId: string): RelayState => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(relayId)) || 'null') as Partial<RelayState> | null;
    if (
      value &&
      typeof value.messagePrefix === 'string' &&
      Number.isSafeInteger(value.nextMessage) &&
      Array.isArray(value.outbox)
    ) {
      return {
        messagePrefix: value.messagePrefix,
        nextMessage: value.nextMessage ?? 0,
        ...(Number.isSafeInteger(value.lastReceived) ? { lastReceived: value.lastReceived } : {}),
        outbox: value.outbox.filter(
          (item): item is OutboundMessage =>
            typeof item?.messageId === 'string' && item.messageId.length > 0 && 'payload' in item,
        ),
      };
    }
  } catch {
    // Corrupt local relay state is replaced with a fresh outbox. The pairing
    // id remains untouched so the user can still reconnect from Settings.
  }
  return createState();
};

export const isRelayId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export class RelayClient {
  readonly relayId: string;

  #onPayload: RelayClientOptions['onPayload'];
  #onStateChange?: RelayClientOptions['onStateChange'];
  #onDisconnect?: RelayClientOptions['onDisconnect'];
  #state: RelayState;
  #socket?: WebSocket;
  #sent = new Set<string>();
  #relayReady = false;
  #manualClose = false;
  #terminal = false;
  #reconnectDelay = MIN_RECONNECT_DELAY;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #receiveChain = Promise.resolve();

  constructor({ relayId, onPayload, onStateChange, onDisconnect }: RelayClientOptions) {
    if (!isRelayId(relayId)) throw new Error('Relay ID 必须是 UUID');
    this.relayId = relayId;
    this.#onPayload = onPayload;
    this.#onStateChange = onStateChange;
    this.#onDisconnect = onDisconnect;
    this.#state = readState(relayId);
  }

  connect = () => {
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) return;
    this.#manualClose = false;
    this.#terminal = false;
    clearTimeout(this.#reconnectTimer);
    this.#emitState('connecting');

    const url = new URL(RELAY_URL);
    url.searchParams.set('id', this.relayId);
    url.searchParams.set('endpoint', '2');
    const socket = new WebSocket(url);
    this.#socket = socket;
    socket.addEventListener('open', this.#handleOpen);
    socket.addEventListener('message', this.#handleMessage);
    socket.addEventListener('close', this.#handleClose);
  };

  close = () => {
    this.#manualClose = true;
    clearTimeout(this.#reconnectTimer);
    this.#detachSocket()?.close();
    this.#emitState('disconnected');
    this.#onDisconnect?.(new Error('Relay 连接已关闭'));
  };

  send = (payload: unknown) => {
    const nextMessage = this.#state.nextMessage + 1;
    if (!Number.isSafeInteger(nextMessage)) throw new Error('Relay 消息编号已耗尽');
    const outbound: OutboundMessage = {
      messageId: `${this.#state.messagePrefix}-${nextMessage}`,
      payload,
    };
    this.#replaceState({
      ...this.#state,
      nextMessage,
      outbox: [...this.#state.outbox, outbound],
    });
    this.#flushOutbox();
  };

  #handleOpen = () => {
    this.#relayReady = false;
    this.#sent.clear();
  };

  #handleMessage = (event: MessageEvent<string>) => {
    this.#receiveChain = this.#receiveChain
      .then(async () => {
        const frame = JSON.parse(event.data) as ServerFrame;
        await this.#handleFrame(frame);
      })
      .catch((error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
  };

  #handleClose = () => {
    this.#detachSocket();
    this.#relayReady = false;
    this.#sent.clear();
    this.#onDisconnect?.(new Error('Relay 连接中断'));
    if (this.#manualClose) {
      this.#emitState('disconnected');
      return;
    }
    if (this.#terminal) {
      this.#emitState('conflict', '此 Relay ID 已在另一台 AgentDeck 上连接');
      return;
    }
    this.#emitState('reconnecting');
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, MAX_RECONNECT_DELAY);
    this.#reconnectTimer = setTimeout(this.connect, delay);
  };

  #handleFrame = async (frame: ServerFrame) => {
    switch (frame.type) {
      case 'ready':
        if (frame.endpoint !== '2') throw new Error(`Relay 返回了错误的 endpoint: ${frame.endpoint}`);
        this.#relayReady = true;
        this.#reconnectDelay = MIN_RECONNECT_DELAY;
        this.#emitState('connected');
        this.#flushOutbox();
        return;
      case 'stored':
        this.#sent.delete(frame.message_id);
        if (this.#state.outbox.some((item) => item.messageId === frame.message_id)) {
          this.#replaceState({
            ...this.#state,
            outbox: this.#state.outbox.filter((item) => item.messageId !== frame.message_id),
          });
        }
        return;
      case 'message': {
        const lastReceived = this.#state.lastReceived;
        if (lastReceived !== undefined && frame.sequence <= lastReceived) {
          this.#sendFrame({ type: 'ack', sequence: frame.sequence });
          return;
        }
        if (lastReceived !== undefined && frame.sequence !== lastReceived + 1) {
          throw new Error(`Relay 消息序列不连续：预期 ${lastReceived + 1}，收到 ${frame.sequence}`);
        }
        await this.#onPayload(frame.payload);
        this.#replaceState({ ...this.#state, lastReceived: frame.sequence });
        this.#sendFrame({ type: 'ack', sequence: frame.sequence });
        return;
      }
      case 'error':
        if (frame.message.startsWith('connection_conflict:')) {
          this.#terminal = true;
          this.#socket?.close();
          return;
        }
        throw new Error(`Relay 拒绝消息：${frame.message}`);
    }
  };

  #flushOutbox = () => {
    if (!this.#relayReady || this.#socket?.readyState !== WebSocket.OPEN) return;
    for (const message of this.#state.outbox) {
      if (this.#sent.has(message.messageId)) continue;
      this.#sendFrame({ type: 'message', message_id: message.messageId, payload: message.payload });
      this.#sent.add(message.messageId);
    }
  };

  #sendFrame = (frame: unknown) => {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(frame));
  };

  #replaceState = (state: RelayState) => {
    localStorage.setItem(storageKey(this.relayId), JSON.stringify(state));
    this.#state = state;
  };

  #fail = (error: Error) => {
    this.#emitState('reconnecting', error.message);
    this.#socket?.close();
  };

  #detachSocket = () => {
    const socket = this.#socket;
    if (!socket) return;
    socket.removeEventListener('open', this.#handleOpen);
    socket.removeEventListener('message', this.#handleMessage);
    socket.removeEventListener('close', this.#handleClose);
    this.#socket = undefined;
    return socket;
  };

  #emitState = (state: RelayConnectionState, error?: string) => this.#onStateChange?.(state, error);
}
