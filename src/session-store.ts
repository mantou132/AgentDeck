import {
  type AcpInboundMessage,
  AcpSocketClient,
  type ConnectionState,
  MockAcpWebSocket,
  type ToolCallStatus,
} from './acp-client';
import { mockMessages, mockSessions } from './mock-data';

export type DeckSession = {
  id: string;
  title: string;
  agent: string;
  model: string;
  cwd: string;
  updatedAt: string;
};

type TextMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  createdAt: string;
  streaming?: boolean;
};

type ThoughtMessage = {
  id: string;
  type: 'thought';
  text: string;
  pending: boolean;
  createdAt: string;
};

export type ToolCallData = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
};

type ToolMessage = {
  id: string;
  type: 'tool';
  data: ToolCallData;
  createdAt: string;
};

export type ChatMessage = TextMessage | ThoughtMessage | ToolMessage;

export const agentdeckStore = createStore({
  sessions: mockSessions,
  messagesBySession: mockMessages,
  pendingSessionIds: [] as string[],
  connection: 'connecting' as ConnectionState,
  transportLabel: 'Mock WebSocket',
  errorsBySession: {} as Record<string, string>,
});

export const acpClient = new AcpSocketClient({
  url: 'ws://127.0.0.1:4789/acp',
  reconnect: true,
  socketFactory: (url) => new MockAcpWebSocket(url),
});

const now = () => new Date().toISOString();

const completeThought = (messages: ChatMessage[]) => {
  const last = messages.at(-1);
  if (!last || !('type' in last) || last.type !== 'thought' || !last.pending) return messages;
  const next = messages.slice();
  next[next.length - 1] = { ...last, pending: false };
  return next;
};

const setMessages = (sessionId: string, messages: ChatMessage[]) => {
  agentdeckStore({
    messagesBySession: { ...agentdeckStore.messagesBySession, [sessionId]: messages },
  });
};

const setPending = (sessionId: string, pending: boolean) => {
  const next = agentdeckStore.pendingSessionIds.filter((id) => id !== sessionId);
  if (pending) next.push(sessionId);
  agentdeckStore({ pendingSessionIds: next });
};

const setError = (sessionId: string, error: string) => {
  agentdeckStore({
    errorsBySession: { ...agentdeckStore.errorsBySession, [sessionId]: error },
  });
};

const touchSession = (sessionId: string, patch: Partial<DeckSession> = {}) => {
  const sessions = agentdeckStore.sessions.map((session) =>
    session.id === sessionId ? { ...session, updatedAt: now(), ...patch } : session,
  );
  agentdeckStore({ sessions });
};

const reduceNotification = (message: AcpInboundMessage) => {
  if (!('method' in message) || message.method !== 'session/update') return;
  const { sessionId, update } = message.params;
  const current = agentdeckStore.messagesBySession[sessionId] ?? [];
  const thoughtChunk =
    update.sessionUpdate === 'agent_thought_chunk' && 'content' in update && update.content?.type === 'text';
  const messages = thoughtChunk ? current : completeThought(current);

  if (
    (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message_chunk') &&
    'content' in update &&
    update.content?.type === 'text'
  ) {
    const role = update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'user';
    const next = messages.slice();
    const last = next.at(-1);
    if (last && 'role' in last && last.role === role && last.streaming) {
      next[next.length - 1] = { ...last, text: last.text + update.content.text };
    } else {
      next.push({ id: crypto.randomUUID(), role, text: update.content.text, streaming: true, createdAt: now() });
    }
    setMessages(sessionId, next);
    touchSession(sessionId);
    return;
  }

  if (thoughtChunk && 'content' in update) {
    const next = messages.slice();
    const last = next.at(-1);
    if (last && 'type' in last && last.type === 'thought') {
      next[next.length - 1] = { ...last, text: last.text + update.content.text, pending: true };
    } else {
      next.push({
        id: crypto.randomUUID(),
        type: 'thought',
        text: update.content.text,
        pending: true,
        createdAt: now(),
      });
    }
    setMessages(sessionId, next);
    return;
  }

  if (update.sessionUpdate === 'tool_call' && 'toolCallId' in update) {
    setMessages(sessionId, [
      ...messages,
      {
        id: crypto.randomUUID(),
        type: 'tool',
        data: {
          toolCallId: update.toolCallId,
          title: typeof update.title === 'string' ? update.title : '工具调用',
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          status: update.status,
          rawInput: update.rawInput,
        },
        createdAt: now(),
      },
    ]);
    return;
  }

  if (update.sessionUpdate === 'tool_call_update' && 'toolCallId' in update) {
    const next = messages.slice();
    const index = next.findLastIndex(
      (item) => 'type' in item && item.type === 'tool' && item.data.toolCallId === update.toolCallId,
    );
    if (index >= 0) {
      const item = next[index] as ToolMessage;
      next[index] = {
        ...item,
        data: {
          ...item.data,
          ...(typeof update.title === 'string' ? { title: update.title } : {}),
          ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
          ...(update.status ? { status: update.status } : {}),
          ...('rawInput' in update ? { rawInput: update.rawInput } : {}),
        },
      };
      setMessages(sessionId, next);
    }
    return;
  }

  if (update.sessionUpdate === 'session_info_update') {
    touchSession(sessionId, {
      ...(typeof update.title === 'string' ? { title: update.title } : {}),
      ...(typeof update.updatedAt === 'string' ? { updatedAt: update.updatedAt } : {}),
    });
  }
};

const finishTurn = (sessionId: string, error = '') => {
  const messages = completeThought(agentdeckStore.messagesBySession[sessionId] ?? []).map((item) =>
    'role' in item && item.streaming ? { ...item, streaming: false } : item,
  );
  setMessages(sessionId, messages);
  setPending(sessionId, false);
  setError(sessionId, error);
};

const handleInbound = (message: AcpInboundMessage) => {
  if ('method' in message) {
    reduceNotification(message);
    return;
  }
  const sessionId = message.context?.sessionId;
  if (!sessionId) return;
  finishTurn(sessionId, message.error?.message ?? '');
};

let started = false;

export const startAcpTransport = () => {
  if (started) return;
  started = true;
  acpClient.onStateChange((connection) => agentdeckStore({ connection }));
  const stream = acpClient.messages();
  void (async () => {
    for await (const message of stream) handleInbound(message);
  })();
  acpClient.connect();
};

export const getSession = (sessionId: string) => agentdeckStore.sessions.find((session) => session.id === sessionId);

export const createSession = () => {
  const id = crypto.randomUUID();
  const session: DeckSession = {
    id,
    title: '新会话',
    agent: 'Codex',
    model: 'GPT-5.6',
    cwd: '~/agentdeck',
    updatedAt: now(),
  };
  agentdeckStore({
    sessions: [session, ...agentdeckStore.sessions],
    messagesBySession: { ...agentdeckStore.messagesBySession, [id]: [] },
  });
  return id;
};

export const sendPrompt = (sessionId: string, prompt: string) => {
  const text = prompt.trim();
  if (
    !text ||
    !agentdeckStore.sessions.some((session) => session.id === sessionId) ||
    agentdeckStore.pendingSessionIds.includes(sessionId)
  ) {
    return false;
  }
  const current = completeThought(agentdeckStore.messagesBySession[sessionId] ?? []);
  setMessages(sessionId, [...current, { id: crypto.randomUUID(), role: 'user', text, createdAt: now() }]);
  const session = agentdeckStore.sessions.find((item) => item.id === sessionId);
  touchSession(sessionId, session?.title === '新会话' ? { title: text.slice(0, 26) } : {});
  setPending(sessionId, true);
  setError(sessionId, '');
  try {
    acpClient.prompt(sessionId, text);
    return true;
  } catch (error) {
    finishTurn(sessionId, error instanceof Error ? error.message : '消息发送失败');
    return false;
  }
};

export const cancelTurn = (sessionId: string) => {
  if (!agentdeckStore.pendingSessionIds.includes(sessionId)) return;
  try {
    acpClient.cancel(sessionId);
  } catch (error) {
    finishTurn(sessionId, error instanceof Error ? error.message : '无法停止当前任务');
  }
};
