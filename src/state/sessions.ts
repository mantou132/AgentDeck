import type { CreatedSession, SessionEvent } from '../agent/api';
import { agentApi, reconnectTransport } from '../agent/transport';
import { completeThought, finishStreaming, reduceSessionEvent } from '../session/events';
import { getSortedSessionGroups } from '../session/groups';
import { getModeSelection, withCurrentMode } from '../session/modes';
import {
  cancelTurnPrompt,
  declineAllPermissions,
  isDraftCanceled,
  performTurn,
  resolvePermission as resolveTurnPermission,
  setDraftCanceled,
} from '../session/turn';
import type { Attachment, DeckSession, SessionOptions, TextMessage } from '../session/types';
import { applyRemoteMode } from './modes';
import {
  agentdeckStore,
  patchSession,
  setMessages,
  setSessionError,
  setSessionFlag,
  updateSessionOptions,
} from './store';

let sessionsRequest = 0;
const sessionLoads = new Map<string, number>();
const failedSessionLoads = new Set<string>();
const localSessions = new Map<string, DeckSession>();

// App 运行生命周期内已成功打开过的 session（只要打开过一次就不再重复 close+load）
const openedSessionIds = new Set<string>();

export const isSessionOpened = (sessionId: string) => openedSessionIds.has(sessionId);

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
    unreadSessionIds: [],
    changingModeSessionIds: [],
    errorsBySession: {},
    optionsBySession: {},
    permissionsBySession: {},
  });
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
  const knownSession = agentdeckStore.sessions.find(
    (session) => session.agent === agent && getModeSelection(agentdeckStore.optionsBySession[session.sessionId]),
  );
  const knownOptions = knownSession ? agentdeckStore.optionsBySession[knownSession.sessionId] : {};
  agentdeckStore({
    draftSession,
    optionsBySession: { ...agentdeckStore.optionsBySession, draft: withCurrentMode(knownOptions, '') },
  });
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
    setSessionError(sessionId, '远端尚未连接，连接后请重试加载');
    return;
  }

  const token = (sessionLoads.get(sessionId) ?? 0) + 1;
  sessionLoads.set(sessionId, token);
  setSessionFlag('loadingSessionIds', sessionId, true);
  setSessionError(sessionId, '');
  setMessages(sessionId, []);

  try {
    // 重启后首次进 session，走一遍 close + load session
    await agentApi.closeSession(session.agent, sessionId);
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
  if (agentdeckStore.connection !== 'connected') {
    reconnectTransport(true);
    return;
  }
  failedSessionLoads.delete(sessionId);
  setSessionError(sessionId, '');
  openedSessionIds.delete(sessionId);
  return ensureSessionLoaded(sessionId);
};

const runPromptTurn = (session: DeckSession, prompt: TextMessage, turnStart: number) => {
  setSessionFlag('unreadSessionIds', session.sessionId, false);
  setSessionFlag('pendingSessionIds', session.sessionId, true);
  setSessionError(session.sessionId, '');
  patchSession(session.sessionId, { updatedAt: new Date().toISOString() });
  void performTurn(
    session,
    prompt.text,
    {
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
      onError: (error) => {
        setSessionError(session.sessionId, error);
        const messages = agentdeckStore.messagesBySession[session.sessionId] ?? [];
        setMessages(
          session.sessionId,
          messages.map((message) => (message.id === prompt.id ? { ...message, failed: true } : message)),
        );
      },
      onDone: (completed) => {
        resolvePermission(session.sessionId, null);
        setMessages(session.sessionId, finishStreaming(agentdeckStore.messagesBySession[session.sessionId] ?? []));
        if (completed && agentdeckStore.pendingSessionIds.includes(session.sessionId)) {
          setSessionFlag('unreadSessionIds', session.sessionId, true);
        }
        setSessionFlag('pendingSessionIds', session.sessionId, false);
      },
    },
    prompt.attachments,
  );
};

export const promoteDraftSession = async (
  draft: DeckSession,
  text: string,
  attachments: Attachment[] = [],
): Promise<DeckSession | null> => {
  if (agentdeckStore.connection !== 'connected') {
    setSessionError('draft', '远端连接后才能新建会话');
    return null;
  }
  const selectedMode = getModeSelection(agentdeckStore.optionsBySession.draft)?.currentValue;
  setDraftCanceled(false);
  const userMessage: TextMessage = { id: crypto.randomUUID(), role: 'user', text, attachments };
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
    title: created.title || text.slice(0, 30) || attachments[0]?.name,
    updatedAt: typeof created.updatedAt === 'string' && created.updatedAt ? created.updatedAt : now,
  };

  let options: SessionOptions = { modes: created.modes, configOptions: created.configOptions };
  let modeError = '';
  if (selectedMode) {
    try {
      options = await applyRemoteMode(liveSession, options, selectedMode);
    } catch (error) {
      modeError = error instanceof Error ? error.message : '切换模式失败，请重试。';
    }
    if (isDraftCanceled()) {
      void agentApi.closeSession(draft.agent, sessionId).catch(() => {});
      setMessages('draft', []);
      setSessionFlag('pendingSessionIds', 'draft', false);
      return null;
    }
  }
  updateSessionOptions(sessionId, options);

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

  if (modeError) {
    setMessages(sessionId, [{ ...userMessage, failed: true }]);
    setSessionError(sessionId, modeError);
  } else {
    runPromptTurn(liveSession, userMessage, stagedMessages.length);
  }
  return liveSession;
};

export const sendPrompt = (sessionId: string, prompt: string, attachments: Attachment[] = []) => {
  const text = prompt.trim();
  const session = getSession(sessionId);
  if (
    (!text && !attachments.length) ||
    !session ||
    session.draft ||
    agentdeckStore.connection !== 'connected' ||
    !agentdeckStore.loadedSessionIds.includes(sessionId) ||
    agentdeckStore.pendingSessionIds.includes(sessionId) ||
    agentdeckStore.changingModeSessionIds.includes(sessionId)
  ) {
    return false;
  }
  const messages = completeThought(agentdeckStore.messagesBySession[sessionId] ?? []);
  const userMessage: TextMessage = { id: crypto.randomUUID(), role: 'user', text, attachments };
  setMessages(sessionId, [...messages, userMessage]);
  const turnStart = messages.length + 1;
  runPromptTurn(session, userMessage, turnStart);
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

export const endSession = (sessionId: string) => {
  setSessionFlag('loadedSessionIds', sessionId, false);
  setSessionFlag('loadingSessionIds', sessionId, false);
  setSessionFlag('pendingSessionIds', sessionId, false);
  openedSessionIds.delete(sessionId);
  resolvePermission(sessionId, null);
  setSessionError(sessionId, '远端会话已结束');
};
