export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type AcpContent = {
  type: 'text';
  text: string;
};

export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk'; content: AcpContent }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      kind?: string;
      status?: ToolCallStatus;
      rawInput?: unknown;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      status?: ToolCallStatus;
      title?: string;
      kind?: string;
      rawInput?: unknown;
    }
  | { sessionUpdate: 'session_info_update'; title?: string; updatedAt?: string };

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpNotification = {
  jsonrpc: '2.0';
  method: 'session/update';
  params: {
    sessionId: string;
    update: AcpSessionUpdate;
  };
};

export type AcpResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: { stopReason?: string };
  error?: { code: number; message: string };
  context?: { sessionId?: string };
};

export type AcpInboundMessage = AcpNotification | AcpResponse;

type SocketLike = {
  readonly readyState: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  send(data: string): void;
  close(): void;
};

type SocketFactory = (url: string) => SocketLike;

type AcpSocketOptions = {
  url: string;
  reconnect?: boolean;
  socketFactory?: SocketFactory;
};

const OPEN = 1;

/**
 * Thin ACP JSON-RPC transport. Incoming messages are exposed as an async
 * iterator so a mock socket and a real browser WebSocket share one consumer.
 */
export class AcpSocketClient {
  #url: string;
  #reconnect: boolean;
  #socketFactory: SocketFactory;
  #socket?: SocketLike;
  #manualClose = false;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #requestId = 0;
  #requestSessions = new Map<number, string>();
  #messageListeners = new Set<(message: AcpInboundMessage) => void>();
  #stateListeners = new Set<(state: ConnectionState) => void>();

  constructor({ url, reconnect = true, socketFactory }: AcpSocketOptions) {
    this.#url = url;
    this.#reconnect = reconnect;
    this.#socketFactory = socketFactory ?? ((socketUrl) => new WebSocket(socketUrl) as unknown as SocketLike);
  }

  connect = () => {
    if (this.#socket && this.#socket.readyState <= OPEN) return;
    this.#manualClose = false;
    this.#emitState('connecting');
    const socket = this.#socketFactory(this.#url);
    this.#socket = socket;
    socket.addEventListener('open', this.#onOpen);
    socket.addEventListener('message', this.#onMessage);
    socket.addEventListener('close', this.#onClose);
    socket.addEventListener('error', this.#onError);
  };

  close = () => {
    this.#manualClose = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#socket = undefined;
    this.#emitState('disconnected');
  };

  prompt = (sessionId: string, prompt: string) =>
    this.#request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });

  cancel = (sessionId: string) => this.#request('session/cancel', { sessionId });

  onStateChange = (listener: (state: ConnectionState) => void) => {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  };

  messages = (): AsyncIterableIterator<AcpInboundMessage> => {
    const pending: AcpInboundMessage[] = [];
    let deferred:
      | { resolve: (value: IteratorResult<AcpInboundMessage>) => void; reject: (reason?: unknown) => void }
      | undefined;
    let done = false;

    const receive = (message: AcpInboundMessage) => {
      if (done) return;
      if (deferred) {
        const waiter = deferred;
        deferred = undefined;
        waiter.resolve({ done: false, value: message });
      } else {
        pending.push(message);
      }
    };

    this.#messageListeners.add(receive);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (done) return { done: true, value: undefined };
        const nextMessage = pending.shift();
        if (nextMessage) return { done: false, value: nextMessage };
        return new Promise<IteratorResult<AcpInboundMessage>>((resolve, reject) => {
          deferred = { resolve, reject };
        });
      },
      return: async () => {
        done = true;
        this.#messageListeners.delete(receive);
        deferred?.resolve({ done: true, value: undefined });
        deferred = undefined;
        return { done: true, value: undefined };
      },
    };
  };

  #request = (method: string, params: Record<string, unknown>) => {
    if (!this.#socket || this.#socket.readyState !== OPEN) {
      throw new Error('ACP WebSocket 尚未连接');
    }
    const id = ++this.#requestId;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    if (sessionId) this.#requestSessions.set(id, sessionId);
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  };

  #onOpen: EventListener = () => this.#emitState('connected');

  #onMessage: EventListener = (event) => {
    try {
      const data = (event as MessageEvent<string>).data;
      const message = JSON.parse(data) as AcpInboundMessage;
      if ('id' in message) {
        const sessionId = this.#requestSessions.get(message.id);
        if (sessionId) message.context = { sessionId };
        this.#requestSessions.delete(message.id);
      }
      for (const listener of this.#messageListeners) listener(message);
    } catch {
      // A malformed frame belongs to the transport boundary; ignore it so one
      // bad server event cannot take down an active session.
    }
  };

  #onClose: EventListener = () => {
    this.#detachSocket();
    if (this.#manualClose || !this.#reconnect) {
      this.#emitState('disconnected');
      return;
    }
    this.#emitState('reconnecting');
    this.#reconnectTimer = setTimeout(this.connect, 1_200);
  };

  #onError: EventListener = () => {
    if (!this.#manualClose) this.#emitState('reconnecting');
  };

  #detachSocket = () => {
    const socket = this.#socket;
    if (!socket) return;
    socket.removeEventListener('open', this.#onOpen);
    socket.removeEventListener('message', this.#onMessage);
    socket.removeEventListener('close', this.#onClose);
    socket.removeEventListener('error', this.#onError);
    this.#socket = undefined;
  };

  #emitState = (state: ConnectionState) => {
    for (const listener of this.#stateListeners) listener(state);
  };
}

/** A WebSocket-shaped ACP peer used until a real endpoint is configured. */
export class MockAcpWebSocket extends EventTarget implements SocketLike {
  readyState = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #sessionTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  constructor(_url: string) {
    super();
    this.#schedule(() => {
      this.readyState = OPEN;
      this.dispatchEvent(new Event('open'));
    }, 180);
  }

  send = (data: string) => {
    const request = JSON.parse(data) as {
      id: number;
      method: string;
      params: { sessionId: string; prompt?: AcpContent[] };
    };
    const { id, method, params } = request;
    if (method === 'session/cancel') {
      this.#clearSession(params.sessionId);
      this.#emit({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } }, 80, params.sessionId);
      return;
    }
    if (method !== 'session/prompt') return;

    const prompt = params.prompt?.find((item) => item.type === 'text')?.text.trim() || '这项任务';
    const topic = prompt.length > 24 ? `${prompt.slice(0, 24)}…` : prompt;
    const sessionId = params.sessionId;
    const toolCallId = `mock-tool-${id}`;
    this.#clearSession(sessionId);

    const update = (value: AcpSessionUpdate, delay: number) =>
      this.#emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } }, delay, sessionId);

    update(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '我先检查相关上下文，再整理出可执行的改动。' },
      },
      220,
    );
    update(
      {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: '读取项目上下文',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'src', query: topic },
      },
      620,
    );
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }, 1_050);
    update(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `已收到“${topic}”。` },
      },
      1_280,
    );
    update(
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '我会沿用当前技术栈处理，并把关键结果、影响范围和验证状态放在同一条回复里。',
        },
      },
      1_620,
    );
    this.#emit({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }, 1_900, sessionId);
  };

  close = () => {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#sessionTimers.clear();
    this.dispatchEvent(new CloseEvent('close'));
  };

  #emit = (message: unknown, delay: number, sessionId?: string) => {
    this.#schedule(
      () => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })),
      delay,
      sessionId,
    );
  };

  #schedule = (callback: () => void, delay: number, sessionId?: string) => {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (sessionId) this.#sessionTimers.get(sessionId)?.delete(timer);
      callback();
    }, delay);
    this.#timers.add(timer);
    if (sessionId) {
      const timers = this.#sessionTimers.get(sessionId) ?? new Set();
      timers.add(timer);
      this.#sessionTimers.set(sessionId, timers);
    }
  };

  #clearSession = (sessionId: string) => {
    for (const timer of this.#sessionTimers.get(sessionId) ?? []) {
      clearTimeout(timer);
      this.#timers.delete(timer);
    }
    this.#sessionTimers.delete(sessionId);
  };
}
