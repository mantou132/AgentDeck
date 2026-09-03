import { isRelayId, RelayClient, type RelayConnectionState } from 'relay-client-ts';
import {
  AgentApi,
  type LoadedSession,
  type PermissionRequest,
  type RemoteAgent,
  type RemoteSession,
  type SessionEvent,
} from './agent-api';

export type AppSettings = {
  relayId: string;
  agent: string;
};

export type DeckSession = RemoteSession & {
  agent: string;
};

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallData = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
};

type Attachment = {
  id: string;
  kind: 'image';
  name: string;
  mimeType: string;
  previewUrl: string;
};

type TextMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  attachments?: Attachment[];
  streaming?: boolean;
};

type ThoughtMessage = {
  id: string;
  type: 'thought';
  text: string;
  pending: boolean;
};

type ToolMessage = {
  id: string;
  type: 'tool';
  data: ToolCallData;
};

export type ChatMessage = TextMessage | ThoughtMessage | ToolMessage;

type SessionOptions = Pick<LoadedSession, 'modes' | 'configOptions'>;

const SETTINGS_KEY = 'agentdeck.settings.v1';
const RELAY_URL =
  process.env.NODE_ENV === 'development' ? 'ws://192.168.77.137:39371/ws' : 'wss://agent-deck.xianqiao.wang/ws';

export const fallbackAgents: RemoteAgent[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'pi', name: 'pi' },
];

const readSettings = (): AppSettings => {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') as Partial<AppSettings> | null;
    const relayId = typeof value?.relayId === 'string' && isRelayId(value.relayId) ? value.relayId : '';
    return {
      relayId,
      agent: typeof value?.agent === 'string' && value.agent ? value.agent : 'codex',
    };
  } catch {
    return { relayId: '', agent: 'codex' };
  }
};

const initialSettings = readSettings();

export const agentdeckStore = createStore({
  settings: initialSettings,
  agents: fallbackAgents,
  connection: (initialSettings.relayId ? 'connecting' : 'disconnected') as RelayConnectionState,
  connectionError: '',
  sessions: [] as DeckSession[],
  sessionsLoading: false,
  sessionsLoaded: false,
  sessionsError: '',
  messagesBySession: {} as Record<string, ChatMessage[]>,
  loadedSessionIds: [] as string[],
  loadingSessionIds: [] as string[],
  pendingSessionIds: [] as string[],
  errorsBySession: {} as Record<string, string>,
  optionsBySession: {} as Record<string, SessionOptions>,
  permissionsBySession: {} as Record<string, PermissionRequest>,
});

const DEVICE_ID_KEY = 'agentdeck.device_id.v1';

const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

let currentPeerId: number | undefined;
const setPeerId = (id: number) => {
  currentPeerId = id;
};

let relayClient: RelayClient | undefined;
export const agentApi = new AgentApi((message) => {
  if (!relayClient) throw new Error('Relay 尚未配置');
  if (currentPeerId !== undefined) {
    (message as Record<string, unknown>).peerId = currentPeerId;
  }
  relayClient.send(message);
});
let started = false;
let sessionsRequest = 0;
const sessionLoads = new Map<string, number>();
const failedSessionLoads = new Set<string>();
const localSessions = new Map<string, DeckSession>();
const permissionResolvers = new Map<string, { resolve: (optionId: string) => void; reject: (error: Error) => void }>();

const setSessionFlag = (
  key: 'loadedSessionIds' | 'loadingSessionIds' | 'pendingSessionIds',
  sessionId: string,
  enabled: boolean,
) => {
  const next = agentdeckStore[key].filter((id) => id !== sessionId);
  if (enabled) next.push(sessionId);
  agentdeckStore({ [key]: next });
};

const setMessages = (sessionId: string, messages: ChatMessage[]) =>
  agentdeckStore({ messagesBySession: { ...agentdeckStore.messagesBySession, [sessionId]: messages } });

const setSessionError = (sessionId: string, error: string) =>
  agentdeckStore({ errorsBySession: { ...agentdeckStore.errorsBySession, [sessionId]: error } });

const patchSession = (sessionId: string, patch: Partial<DeckSession>) =>
  agentdeckStore({
    sessions: agentdeckStore.sessions.map((session) =>
      session.sessionId === sessionId ? { ...session, ...patch } : session,
    ),
  });

const completeThought = (messages: ChatMessage[]) => {
  const last = messages.at(-1);
  if (!last || !('type' in last) || last.type !== 'thought' || !last.pending) return messages;
  const next = messages.slice();
  next[next.length - 1] = { ...last, pending: false };
  return next;
};

const finishStreaming = (messages: ChatMessage[]) =>
  completeThought(messages).map((message) =>
    'role' in message && message.streaming ? { ...message, streaming: false } : message,
  );

const appendContent = (messages: ChatMessage[], role: 'user' | 'agent', text: string, streaming: boolean) => {
  const next = messages.slice();
  const last = next.at(-1);
  if (last && 'role' in last && last.role === role && last.streaming === streaming) {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ id: crypto.randomUUID(), role, text, streaming });
  }
  return next;
};

const appendImage = (
  messages: ChatMessage[],
  role: 'user' | 'agent',
  content: Record<string, unknown>,
  streaming: boolean,
) => {
  const data = typeof content.data === 'string' ? content.data : '';
  if (!data) return messages;
  const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'image/png';
  const attachment: Attachment = {
    id: crypto.randomUUID(),
    kind: 'image',
    name: '图片',
    mimeType,
    previewUrl: `data:${mimeType};base64,${data}`,
  };
  const next = messages.slice();
  const last = next.at(-1);
  if (last && 'role' in last && last.role === role && last.streaming === streaming) {
    next[next.length - 1] = { ...last, attachments: [...(last.attachments ?? []), attachment] };
  } else {
    next.push({ id: crypto.randomUUID(), role, text: '', attachments: [attachment], streaming });
  }
  return next;
};

const updateSessionOptions = (sessionId: string, patch: Partial<SessionOptions>) => {
  const current = agentdeckStore.optionsBySession[sessionId] ?? {};
  agentdeckStore({
    optionsBySession: { ...agentdeckStore.optionsBySession, [sessionId]: { ...current, ...patch } },
  });
};

const reduceSessionEvent = (sessionId: string, event: SessionEvent) => {
  const current = agentdeckStore.messagesBySession[sessionId] ?? [];
  if (event.event === 'stop') {
    setMessages(sessionId, finishStreaming(current));
    return;
  }
  const update = event.update;
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  const thoughtChunk = sessionUpdate === 'agent_thought_chunk';
  const messages = thoughtChunk ? current : completeThought(current);
  const streaming = agentdeckStore.pendingSessionIds.includes(sessionId);
  const content =
    update.content && typeof update.content === 'object' ? (update.content as Record<string, unknown>) : {};
  const role =
    sessionUpdate === 'agent_message_chunk' ? 'agent' : sessionUpdate === 'user_message_chunk' ? 'user' : undefined;

  if (role && content.type === 'text' && typeof content.text === 'string') {
    if (
      agentdeckStore.settings.agent === 'claude' &&
      role === 'user' &&
      content.text.trim() === '[Request interrupted by user]'
    ) {
      if (messages !== current) setMessages(sessionId, messages);
      return;
    }
    setMessages(sessionId, appendContent(messages, role, content.text, streaming));
    return;
  }

  if (role && content.type === 'image') {
    setMessages(sessionId, appendImage(messages, role, content, streaming));
    return;
  }

  if (thoughtChunk && content.type === 'text' && typeof content.text === 'string') {
    const next = messages.slice();
    const last = next.at(-1);
    if (last && 'type' in last && last.type === 'thought') {
      next[next.length - 1] = { ...last, text: last.text + content.text, pending: true };
    } else {
      next.push({ id: crypto.randomUUID(), type: 'thought', text: content.text, pending: true });
    }
    setMessages(sessionId, next);
    return;
  }

  if (sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') {
    setMessages(sessionId, [
      ...messages,
      {
        id: crypto.randomUUID(),
        type: 'tool',
        data: {
          toolCallId: update.toolCallId,
          title: typeof update.title === 'string' ? update.title : '工具调用',
          ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
          ...(typeof update.status === 'string' ? { status: update.status as ToolCallStatus } : {}),
          ...('rawInput' in update ? { rawInput: update.rawInput } : {}),
        },
      },
    ]);
    return;
  }

  if (sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string') {
    const next = messages.slice();
    const index = next.findLastIndex(
      (message) => 'type' in message && message.type === 'tool' && message.data.toolCallId === update.toolCallId,
    );
    const patch: Partial<ToolCallData> = {
      ...(typeof update.title === 'string' ? { title: update.title } : {}),
      ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
      ...(typeof update.status === 'string' ? { status: update.status as ToolCallStatus } : {}),
      ...('rawInput' in update ? { rawInput: update.rawInput } : {}),
    };
    if (index < 0) {
      next.push({
        id: crypto.randomUUID(),
        type: 'tool',
        data: { toolCallId: update.toolCallId, title: patch.title ?? '工具调用', ...patch },
      });
    } else {
      const message = next[index] as ToolMessage;
      next[index] = { ...message, data: { ...message.data, ...patch } };
    }
    setMessages(sessionId, next);
    return;
  }

  if (sessionUpdate === 'session_info_update') {
    patchSession(sessionId, {
      ...(typeof update.title === 'string' && update.title ? { title: update.title } : {}),
      ...(typeof update.updatedAt === 'string' && update.updatedAt ? { updatedAt: update.updatedAt } : {}),
    });
    const local = localSessions.get(sessionId);
    if (local) {
      localSessions.set(sessionId, {
        ...local,
        ...(typeof update.title === 'string' && update.title ? { title: update.title } : {}),
        ...(typeof update.updatedAt === 'string' && update.updatedAt ? { updatedAt: update.updatedAt } : {}),
      });
    }
    return;
  }

  if (sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
    const options = agentdeckStore.optionsBySession[sessionId]?.configOptions ?? [];
    updateSessionOptions(sessionId, {
      configOptions: options.map((option) => {
        if (!option || typeof option !== 'object' || (option as { id?: unknown }).id !== 'mode') return option;
        return { ...(option as object), currentValue: update.currentModeId };
      }),
    });
    return;
  }

  if (sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
    updateSessionOptions(sessionId, { configOptions: update.configOptions });
  }
};

const requestPermission = (request: PermissionRequest) => {
  if (!request?.sessionId) return Promise.reject(new Error('权限请求缺少 sessionId'));
  permissionResolvers.get(request.sessionId)?.reject(new Error('权限请求已被新请求替换'));
  agentdeckStore({
    permissionsBySession: { ...agentdeckStore.permissionsBySession, [request.sessionId]: request },
  });
  return new Promise<string>((resolve, reject) => permissionResolvers.set(request.sessionId, { resolve, reject }));
};

export const resolvePermission = (sessionId: string, optionId: string | null) => {
  const resolver = permissionResolvers.get(sessionId);
  permissionResolvers.delete(sessionId);
  const permissionsBySession = { ...agentdeckStore.permissionsBySession };
  delete permissionsBySession[sessionId];
  agentdeckStore({ permissionsBySession });
  if (!resolver) return;
  if (optionId) resolver.resolve(optionId);
  else resolver.reject(new Error('用户取消了权限请求'));
};

const resetRemoteState = () => {
  sessionsRequest += 1;
  sessionLoads.clear();
  failedSessionLoads.clear();
  localSessions.clear();
  for (const sessionId of permissionResolvers.keys()) resolvePermission(sessionId, null);
  agentdeckStore({
    sessions: [],
    sessionsLoading: false,
    sessionsLoaded: false,
    sessionsError: '',
    messagesBySession: {},
    loadedSessionIds: [],
    loadingSessionIds: [],
    pendingSessionIds: [],
    errorsBySession: {},
    optionsBySession: {},
    permissionsBySession: {},
  });
};

const startRelay = (relayId: string) => {
  relayClient?.close();
  relayClient = new RelayClient({
    relayId,
    endpoint: '2',
    relayUrl: RELAY_URL,
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
    onDisconnect: (error) => {
      currentPeerId = undefined;
      agentApi.rejectAll(error);
    },
    onStateChange: (connection, connectionError = '') => {
      agentdeckStore({ connection, connectionError });
      if (connection === 'connected') {
        void syncHostConnection();
      }
    },
  });
  relayClient.connect();
};

export const startApp = () => {
  if (started) return;
  started = true;
  agentApi.setPermissionHandler(requestPermission);
  agentApi.setSessionEndedHandler(({ sessionId }) => {
    setSessionFlag('loadedSessionIds', sessionId, false);
    setSessionFlag('loadingSessionIds', sessionId, false);
    setSessionFlag('pendingSessionIds', sessionId, false);
    resolvePermission(sessionId, null);
    setSessionError(sessionId, '远端会话已结束；返回列表后可重新加载历史记录');
  });
  agentApi.setHostReconnectedHandler(() => {
    void syncHostConnection();
  });
  if (isRelayId(agentdeckStore.settings.relayId)) startRelay(agentdeckStore.settings.relayId);
};

export const saveSettings = (settings: AppSettings) => {
  const next = { relayId: settings.relayId.trim(), agent: settings.agent.trim() };
  if (!isRelayId(next.relayId)) throw new Error('请输入有效的 Relay UUID');
  if (!next.agent) throw new Error('请选择远端 Agent');
  const relayChanged = next.relayId !== agentdeckStore.settings.relayId;
  const agentChanged = next.agent !== agentdeckStore.settings.agent;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  agentdeckStore({ settings: next, connectionError: '' });
  if (relayChanged || agentChanged) {
    localSessions.clear();
    resetRemoteState();
  }
  if (relayChanged) startRelay(next.relayId);
  else if (agentChanged && agentdeckStore.connection === 'connected') void refreshSessions();
};

export const refreshSessions = async () => {
  console.log({ ...agentdeckStore });
  if (agentdeckStore.connection !== 'connected') {
    agentdeckStore({ sessionsError: 'Relay 连接后才能读取会话' });
    return;
  }
  const request = ++sessionsRequest;
  const agent = agentdeckStore.settings.agent;
  agentdeckStore({ sessionsLoading: true, sessionsError: '' });
  try {
    const [agents, sessions] = await Promise.all([agentApi.listAgents(), agentApi.listSessions(agent)]);
    if (request !== sessionsRequest || agent !== agentdeckStore.settings.agent) return;
    const normalized = sessions
      .filter((session) => typeof session.sessionId === 'string' && typeof session.cwd === 'string')
      .map((session) => ({ ...session, agent }))
      .sort((left, right) => Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || ''));
    agentdeckStore({
      ...(agents.length ? { agents } : {}),
      sessions: normalized,
      sessionsLoaded: true,
      sessionsLoading: false,
    });
  } catch (error) {
    if (request !== sessionsRequest) return;
    agentdeckStore({
      sessionsLoading: false,
      sessionsLoaded: true,
      sessionsError: error instanceof Error ? error.message : '读取会话失败',
    });
  }
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
  await refreshSessions();
};

export const getSession = (sessionId: string) => {
  const remote = agentdeckStore.sessions.find((session) => session.sessionId === sessionId);
  if (remote) return remote;
  const agent = agentdeckStore.settings.agent;
  return localSessions.get(sessionId) && agent ? localSessions.get(sessionId) : undefined;
};

export type CreateSessionInput = {
  agent: string;
  cwd: string;
};

export const createSession = async ({ agent, cwd }: CreateSessionInput) => {
  if (agentdeckStore.connection !== 'connected') throw new Error('Relay 连接后才能新建会话');
  const created = await agentApi.createSession({ agent, cwd });
  if (typeof created.sessionId !== 'string' || !created.sessionId) {
    throw new Error('远端 Agent 未返回 sessionId');
  }
  const session: DeckSession = {
    agent,
    sessionId: created.sessionId,
    cwd,
    ...(typeof created.title === 'string' && created.title ? { title: created.title } : {}),
    ...(typeof created.updatedAt === 'string' && created.updatedAt ? { updatedAt: created.updatedAt } : {}),
  };
  localSessions.set(session.sessionId, session);
  return session;
};

export const loadSession = async (sessionId: string) => {
  if (agentdeckStore.loadedSessionIds.includes(sessionId)) return;
  if (agentdeckStore.loadingSessionIds.includes(sessionId)) return;
  if (failedSessionLoads.has(sessionId)) return;
  const session = getSession(sessionId);
  if (!session) return;
  if (agentdeckStore.connection !== 'connected') {
    failedSessionLoads.add(sessionId);
    setSessionError(sessionId, 'Relay 尚未连接');
    return;
  }
  const token = (sessionLoads.get(sessionId) ?? 0) + 1;
  sessionLoads.set(sessionId, token);
  setSessionFlag('loadingSessionIds', sessionId, true);
  setSessionError(sessionId, '');
  setMessages(sessionId, []);
  try {
    await agentApi.closeSession(session.agent, sessionId).catch(() => {});
    const loaded = await agentApi.loadSession(session, session.agent, (event) => reduceSessionEvent(sessionId, event));
    if (sessionLoads.get(sessionId) !== token) return;
    failedSessionLoads.delete(sessionId);
    setMessages(sessionId, finishStreaming(agentdeckStore.messagesBySession[sessionId] ?? []));
    setSessionFlag('loadingSessionIds', sessionId, false);
    setSessionFlag('loadedSessionIds', sessionId, true);
    updateSessionOptions(sessionId, { modes: loaded.modes, configOptions: loaded.configOptions ?? [] });
    patchSession(sessionId, {
      ...(loaded.title ? { title: loaded.title } : {}),
      ...(loaded.updatedAt ? { updatedAt: loaded.updatedAt } : {}),
    });
  } catch (error) {
    if (sessionLoads.get(sessionId) !== token) return;
    failedSessionLoads.add(sessionId);
    setSessionFlag('loadingSessionIds', sessionId, false);
    setSessionError(sessionId, error instanceof Error ? error.message : '加载会话失败');
  }
};

export const retrySessionLoad = (sessionId: string) => {
  failedSessionLoads.delete(sessionId);
  setSessionError(sessionId, '');
  return loadSession(sessionId);
};

export const sendPrompt = (sessionId: string, prompt: string) => {
  const text = prompt.trim();
  const session = getSession(sessionId);
  if (
    !text ||
    !session ||
    agentdeckStore.connection !== 'connected' ||
    !agentdeckStore.loadedSessionIds.includes(sessionId) ||
    agentdeckStore.pendingSessionIds.includes(sessionId)
  ) {
    return false;
  }
  const messages = completeThought(agentdeckStore.messagesBySession[sessionId] ?? []);
  setMessages(sessionId, [...messages, { id: crypto.randomUUID(), role: 'user', text }]);
  const turnStart = messages.length + 1;
  setSessionFlag('pendingSessionIds', sessionId, true);
  setSessionError(sessionId, '');
  patchSession(sessionId, { updatedAt: new Date().toISOString() });
  void (async () => {
    try {
      const result = await agentApi.prompt(sessionId, session.agent, text, (event) =>
        reduceSessionEvent(sessionId, event),
      );
      const current = agentdeckStore.messagesBySession[sessionId] ?? [];
      const receivedAgentText = current
        .slice(turnStart)
        .some((message) => 'role' in message && message.role === 'agent' && message.text);
      if (result.answer && !receivedAgentText) {
        setMessages(sessionId, [...current, { id: crypto.randomUUID(), role: 'agent', text: result.answer }]);
      }
    } catch (error) {
      setSessionError(sessionId, error instanceof Error ? error.message : '发送消息失败');
    } finally {
      setMessages(sessionId, finishStreaming(agentdeckStore.messagesBySession[sessionId] ?? []));
      setSessionFlag('pendingSessionIds', sessionId, false);
    }
  })();
  return true;
};

export const cancelTurn = (sessionId: string) => {
  const session = getSession(sessionId);
  if (!session || !agentdeckStore.pendingSessionIds.includes(sessionId)) return;
  resolvePermission(sessionId, null);
  void agentApi
    .cancelPrompt(sessionId, session.agent)
    .catch((error) => setSessionError(sessionId, error instanceof Error ? error.message : '停止任务失败'));
};

const optionLabel = (option: unknown) => {
  if (!option || typeof option !== 'object') return '';
  const record = option as {
    id?: unknown;
    name?: unknown;
    currentValue?: unknown;
    options?: { value?: unknown; name?: unknown }[];
  };
  if (typeof record.currentValue !== 'string') return '';
  const selected = record.options?.find((item) => item.value === record.currentValue);
  const name = typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : '';
  const value = typeof selected?.name === 'string' ? selected.name : record.currentValue;
  return name ? `${name}: ${value}` : value;
};

export const getOptionLabels = (sessionId: string) => {
  const options = agentdeckStore.optionsBySession[sessionId];
  const labels = (options?.configOptions ?? []).map(optionLabel).filter(Boolean);
  if (labels.length) return labels;
  if (options?.modes && typeof options.modes === 'object') {
    const modes = options.modes as {
      currentModeId?: unknown;
      availableModes?: { id?: unknown; name?: unknown }[];
    };
    if (typeof modes.currentModeId === 'string') {
      const selected = modes.availableModes?.find((mode) => mode.id === modes.currentModeId);
      return [typeof selected?.name === 'string' ? selected.name : modes.currentModeId];
    }
  }
  return ['ACP 默认值'];
};
