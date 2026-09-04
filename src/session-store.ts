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
  readSettings,
  reduceSessionEvent,
  SETTINGS_KEY,
  type SessionOptions,
} from './session-runtime';
import {
  agentApi,
  initAppTransport,
  startRelay,
  syncHostConnection,
  type TransportHandlers,
} from './session-transport';
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
export { agentApi, syncHostConnection } from './session-transport';

const initialSettings = readSettings();

export const agentdeckStore = createStore({
  settings: initialSettings,
  agents: fallbackAgents,
  connection: (initialSettings.relayId ? 'connecting' : 'disconnected') as RelayConnectionState,
  connectionError: '',
  draftSession: null as DeckSession | null,
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

let sessionsRequest = 0;
const sessionLoads = new Map<string, number>();
const failedSessionLoads = new Set<string>();
const localSessions = new Map<string, DeckSession>();

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
  declineAllPermissions((id) => {
    const permissionsBySession = { ...agentdeckStore.permissionsBySession };
    delete permissionsBySession[id];
    agentdeckStore({ permissionsBySession });
  });
  agentdeckStore({
    draftSession: null,
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

const transportHandlers: TransportHandlers = {
  onStateChange: (connection, connectionError = '') => {
    agentdeckStore({ connection, connectionError });
  },
  onConnected: () => {
    void syncHostConnection(() => refreshSessions());
  },
};

export const startApp = () => {
  initAppTransport({
    initialRelayId: agentdeckStore.settings.relayId,
    onRequestPermission: (request) =>
      requestTurnPermission(request, (req) => {
        agentdeckStore({
          permissionsBySession: { ...agentdeckStore.permissionsBySession, [req.sessionId]: req },
        });
      }),
    onSessionEnded: (sessionId) => {
      setSessionFlag('loadedSessionIds', sessionId, false);
      setSessionFlag('loadingSessionIds', sessionId, false);
      setSessionFlag('pendingSessionIds', sessionId, false);
      resolvePermission(sessionId, null);
      setSessionError(sessionId, '远端会话已结束；返回列表后可重新加载历史记录');
    },
    onHostReconnected: () => {
      void syncHostConnection(() => refreshSessions());
    },
    transportHandlers,
  });
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
  if (relayChanged) startRelay(next.relayId, transportHandlers);
  else if (agentChanged && agentdeckStore.connection === 'connected') void refreshSessions();
};

export const refreshSessions = async () => {
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

export const loadSession = async (sessionId: string) => {
  if (sessionId === 'draft') return;
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
    const loaded = await agentApi.loadSession(session, session.agent, (event) => applySessionEvent(sessionId, event));
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
  const stagedMessages = agentdeckStore.messagesBySession.draft ?? [userMessage];

  agentdeckStore({
    sessions: [liveSession, ...agentdeckStore.sessions.filter((s) => s.sessionId !== liveSession.sessionId)],
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
