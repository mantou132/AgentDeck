import { isRelayId, type RelayConnectionState } from 'relay-client-ts';
import type { CreatedSession, PermissionRequest, SessionEvent } from './agent-api';
import {
  type AppSettings,
  type ChatMessage,
  completeThought,
  type DeckSession,
  fallbackAgents,
  finishStreaming,
  formatOptionLabels,
  RESET_PENDING_KEY,
  readSettings,
  reduceSessionEvent,
  SETTINGS_KEY,
  type SessionOptions,
} from './session-runtime';
import {
  agentApi,
  clearTransportStorage,
  initTransport,
  reconnectTransport,
  startTransport,
  syncHostConnection,
  type TransportMessage,
} from './transport';
import {
  cancelTurnPrompt,
  declineAllPermissions,
  isDraftCanceled,
  performTurn,
  requestPermission as requestTurnPermission,
  resolvePermission as resolveTurnPermission,
  setDraftCanceled,
} from './turn-controller';

export * from './session-runtime';
export { agentApi, reconnectTransport } from './transport';

export type SessionGroup = {
  cwd: string;
  latestActivity: number;
  sessions: DeckSession[];
};

export const getSortedSessionGroups = (sessions: DeckSession[]): SessionGroup[] => {
  const groupsMap = Map.groupBy(sessions, (session) => session.cwd);
  const groups: SessionGroup[] = [];
  for (const [cwd, items] of groupsMap) {
    const sortedItems = [...items].sort(
      (a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0),
    );
    const latestActivity = sortedItems.reduce((max, s) => {
      const time = Date.parse(s.updatedAt || '') || 0;
      return time > max ? time : max;
    }, 0);
    groups.push({ cwd, latestActivity, sessions: sortedItems });
  }
  return groups.sort((a, b) => b.latestActivity - a.latestActivity);
};

const initialSettings = readSettings();

export const agentdeckStore = createStore({
  settings: initialSettings,
  agents: fallbackAgents,
  connection: (initialSettings.relayId ? 'connecting' : 'disconnected') as RelayConnectionState,
  connectionError: '',
  draftSession: null as DeckSession | null,
  sessions: [] as DeckSession[],
  sessionGroups: [] as SessionGroup[],
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

let sessionsRequest = 0;
const sessionLoads = new Map<string, number>();
const failedSessionLoads = new Set<string>();
const localSessions = new Map<string, DeckSession>();

// App 运行生命周期内已成功打开过的 session（只要打开过一次就不再重复 close+load）
const openedSessionIds = new Set<string>();

export const isSessionOpened = (sessionId: string) => openedSessionIds.has(sessionId);

export const clearSessionError = (sessionId: string) => {
  const next = { ...agentdeckStore.errorsBySession };
  delete next[sessionId];
  agentdeckStore({ errorsBySession: next });
};

export const clearNetworkErrors = () => {
  const errors = { ...agentdeckStore.errorsBySession };
  let changed = false;
  for (const [id, error] of Object.entries(errors)) {
    if (error === 'Relay 连接中断' || error === 'Relay 尚未连接') {
      delete errors[id];
      changed = true;
    }
  }
  if (changed) {
    agentdeckStore({ errorsBySession: errors });
  }
};

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

const patchSession = (sessionId: string, patch: Partial<DeckSession>) => {
  const nextSessions = agentdeckStore.sessions.map((session) =>
    session.sessionId === sessionId ? { ...session, ...patch } : session,
  );
  agentdeckStore({
    sessions: nextSessions,
    sessionGroups: getSortedSessionGroups(nextSessions),
  });
};

const updateSessionOptions = (sessionId: string, patch: Partial<SessionOptions>) => {
  const current = agentdeckStore.optionsBySession[sessionId] ?? {};
  agentdeckStore({
    optionsBySession: { ...agentdeckStore.optionsBySession, [sessionId]: { ...current, ...patch } },
  });
};

export const applySessionEvent = (sessionId: string, event: SessionEvent) => {
  const current = agentdeckStore.messagesBySession[sessionId] ?? [];
  const streaming = agentdeckStore.pendingSessionIds.includes(sessionId);
  const options = agentdeckStore.optionsBySession[sessionId];
  const agent = getSession(sessionId)?.agent ?? agentdeckStore.settings.agent;
  const reduction = reduceSessionEvent(current, event, { agent, streaming, options });
  if (!reduction) return;
  if (reduction.messages) setMessages(sessionId, reduction.messages);
  if (reduction.sessionPatch) {
    patchSession(sessionId, reduction.sessionPatch);
    const local = localSessions.get(sessionId);
    if (local) localSessions.set(sessionId, { ...local, ...reduction.sessionPatch });
  }
  if (reduction.optionsPatch) updateSessionOptions(sessionId, reduction.optionsPatch);
};

export const resolvePermission = (sessionId: string, optionId: string | null) => {
  resolveTurnPermission(sessionId, optionId, (id) => {
    const permissionsBySession = { ...agentdeckStore.permissionsBySession };
    delete permissionsBySession[id];
    agentdeckStore({ permissionsBySession });
  });
};

export const resetRemoteState = () => {
  sessionsRequest += 1;
  sessionLoads.clear();
  failedSessionLoads.clear();
  localSessions.clear();
  openedSessionIds.clear();
  declineAllPermissions((id) => {
    const permissionsBySession = { ...agentdeckStore.permissionsBySession };
    delete permissionsBySession[id];
    agentdeckStore({ permissionsBySession });
  });
  agentdeckStore({
    draftSession: null,
    sessions: [],
    sessionGroups: [],
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

/**
 * 唯一的底层消息消费中枢：
 * Web socket 连接与 App 状态彻底解耦，App 仅在此单一点响应状态与消息。
 */
const handleTransportMessage = (message: TransportMessage) => {
  switch (message.type) {
    case 'connection': {
      const { connection, error } = message;
      agentdeckStore({ connection, connectionError: error || '' });
      if (connection === 'connected') {
        clearNetworkErrors();
        void syncHostConnection().then(() => refreshSessions());
      }
      break;
    }
    case 'session_event': {
      applySessionEvent(message.sessionId, message.event);
      break;
    }
    case 'session_ended': {
      setSessionFlag('loadedSessionIds', message.sessionId, false);
      setSessionFlag('loadingSessionIds', message.sessionId, false);
      setSessionFlag('pendingSessionIds', message.sessionId, false);
      openedSessionIds.delete(message.sessionId);
      resolvePermission(message.sessionId, null);
      setSessionError(message.sessionId, '远端会话已结束');
      break;
    }
    case 'host_reconnected': {
      clearNetworkErrors();
      void syncHostConnection().then(() => refreshSessions());
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
    localSessions.clear();
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

export const refreshSessions = async () => {
  if (agentdeckStore.connection !== 'connected') {
    reconnectTransport(true);
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
      .map((session) => ({ ...session, agent }));
    const groups = getSortedSessionGroups(normalized);
    agentdeckStore({
      ...(agents.length ? { agents } : {}),
      sessions: normalized,
      sessionGroups: groups,
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

export const getSession = (sessionId: string) => {
  if (sessionId === 'draft') return agentdeckStore.draftSession ?? undefined;
  const remote = agentdeckStore.sessions.find((session) => session.sessionId === sessionId);
  if (remote) return remote;
  const agent = agentdeckStore.settings.agent;
  return localSessions.get(sessionId) && agent ? localSessions.get(sessionId) : undefined;
};

export type CreateSessionInput = {
  agent: string;
  cwd: string;
};

export const createDraftSession = ({ agent, cwd }: CreateSessionInput): DeckSession => {
  const draftSession: DeckSession = {
    agent,
    sessionId: 'draft',
    cwd,
    title: '新建会话',
    draft: true,
    updatedAt: new Date().toISOString(),
  };
  localSessions.delete('draft');
  setMessages('draft', []);
  setSessionError('draft', '');
  setSessionFlag('loadingSessionIds', 'draft', false);
  setSessionFlag('pendingSessionIds', 'draft', false);
  setSessionFlag('loadedSessionIds', 'draft', true);
  agentdeckStore({ draftSession });
  return draftSession;
};

export const resetDraftSession = () => {
  if (!agentdeckStore.draftSession) return;
  setMessages('draft', []);
  setSessionError('draft', '');
  setSessionFlag('loadingSessionIds', 'draft', false);
  setSessionFlag('pendingSessionIds', 'draft', false);
  setSessionFlag('loadedSessionIds', 'draft', false);
  agentdeckStore({ draftSession: null });
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

/**
 * 核心运行规则：
 * session 只要打开过一次，就不用关闭了，也不用重复走 close+load session。
 * 除非重启 app（openedSessionIds 为空），首次进入 session 才走一遍 close + load。
 */
export const ensureSessionLoaded = async (sessionId: string) => {
  if (sessionId === 'draft') return;
  if (openedSessionIds.has(sessionId)) {
    // 已经打开过，保持在内存中直接秒开，绝不重复走 close + load
    return;
  }
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
    // 重启后首次进 session，走一遍 close + load session
    await agentApi.closeSession(session.agent, sessionId).catch(() => {});
    const loaded = await agentApi.loadSession(session, session.agent, (event) => applySessionEvent(sessionId, event));
    if (sessionLoads.get(sessionId) !== token) return;
    failedSessionLoads.delete(sessionId);
    openedSessionIds.add(sessionId);
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
  openedSessionIds.delete(sessionId);
  return ensureSessionLoaded(sessionId);
};

const runPromptTurn = (session: DeckSession, text: string, turnStart: number) => {
  setSessionFlag('pendingSessionIds', session.sessionId, true);
  setSessionError(session.sessionId, '');
  patchSession(session.sessionId, { updatedAt: new Date().toISOString() });
  void performTurn(session, text, {
    onEvent: (event) => applySessionEvent(session.sessionId, event),
    onAnswer: (answer) => {
      const current = agentdeckStore.messagesBySession[session.sessionId] ?? [];
      const receivedAgentText = current
        .slice(turnStart)
        .some((message) => 'role' in message && message.role === 'agent' && message.text);
      if (!receivedAgentText) {
        setMessages(session.sessionId, [...current, { id: crypto.randomUUID(), role: 'agent', text: answer }]);
      }
    },
    onError: (error) => setSessionError(session.sessionId, error),
    onDone: () => {
      setMessages(session.sessionId, finishStreaming(agentdeckStore.messagesBySession[session.sessionId] ?? []));
      setSessionFlag('pendingSessionIds', session.sessionId, false);
    },
  });
};

export const promoteDraftSession = async (draft: DeckSession, text: string): Promise<DeckSession | null> => {
  if (agentdeckStore.connection !== 'connected') {
    setSessionError('draft', 'Relay 连接后才能新建会话');
    return null;
  }
  setDraftCanceled(false);
  const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text };
  setMessages('draft', [userMessage]);
  setSessionFlag('pendingSessionIds', 'draft', true);
  setSessionError('draft', '');

  let created: CreatedSession;
  try {
    created = await agentApi.createSession({ agent: draft.agent, cwd: draft.cwd });
    if (typeof created.sessionId !== 'string' || !created.sessionId) {
      throw new Error('远端 Agent 未返回 sessionId');
    }
  } catch (error) {
    setMessages('draft', []);
    setSessionFlag('pendingSessionIds', 'draft', false);
    setSessionError('draft', error instanceof Error ? error.message : '创建会话失败');
    return null;
  }

  const sessionId = created.sessionId;
  if (isDraftCanceled()) {
    void agentApi.closeSession(draft.agent, sessionId).catch(() => {});
    setMessages('draft', []);
    setSessionFlag('pendingSessionIds', 'draft', false);
    return null;
  }

  const now = new Date().toISOString();
  const liveSession: DeckSession = {
    agent: draft.agent,
    sessionId,
    cwd: draft.cwd,
    title: created.title || text.slice(0, 30),
    updatedAt: typeof created.updatedAt === 'string' && created.updatedAt ? created.updatedAt : now,
  };

  localSessions.set(liveSession.sessionId, liveSession);
  openedSessionIds.add(liveSession.sessionId);
  const stagedMessages = agentdeckStore.messagesBySession.draft ?? [userMessage];
  const nextSessions = [liveSession, ...agentdeckStore.sessions.filter((s) => s.sessionId !== liveSession.sessionId)];

  agentdeckStore({
    sessions: nextSessions,
    sessionGroups: getSortedSessionGroups(nextSessions),
    messagesBySession: {
      ...agentdeckStore.messagesBySession,
      [liveSession.sessionId]: stagedMessages,
      draft: [],
    },
    draftSession: null,
  });

  setSessionFlag('loadedSessionIds', 'draft', false);
  setSessionFlag('pendingSessionIds', 'draft', false);
  setSessionFlag('loadedSessionIds', liveSession.sessionId, true);

  runPromptTurn(liveSession, text, stagedMessages.length);
  return liveSession;
};

export const sendPrompt = (sessionId: string, prompt: string) => {
  const text = prompt.trim();
  const session = getSession(sessionId);
  if (
    !text ||
    !session ||
    session.draft ||
    agentdeckStore.connection !== 'connected' ||
    !agentdeckStore.loadedSessionIds.includes(sessionId) ||
    agentdeckStore.pendingSessionIds.includes(sessionId)
  ) {
    return false;
  }
  const messages = completeThought(agentdeckStore.messagesBySession[sessionId] ?? []);
  setMessages(sessionId, [...messages, { id: crypto.randomUUID(), role: 'user', text }]);
  const turnStart = messages.length + 1;
  runPromptTurn(session, text, turnStart);
  return true;
};

export const cancelTurn = (sessionId: string) => {
  const session = getSession(sessionId);
  if (!session || !agentdeckStore.pendingSessionIds.includes(sessionId)) return;
  resolvePermission(sessionId, null);
  if (session.draft) {
    setDraftCanceled(true);
    setSessionFlag('pendingSessionIds', sessionId, false);
    return;
  }
  void cancelTurnPrompt(session).catch((error) =>
    setSessionError(sessionId, error instanceof Error ? error.message : '停止任务失败'),
  );
};

export const getOptionLabels = (sessionId: string) => {
  return formatOptionLabels(agentdeckStore.optionsBySession[sessionId]);
};
