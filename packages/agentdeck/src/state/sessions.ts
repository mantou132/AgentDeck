import { TapSwipeoutElement } from '@mantou/tap-ui/elements/swipeout';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { type CreatedSession, REMOTE_APP_PANEL_CONTEXT, type SessionEvent, type UserInput } from '../agent/api';
import { agentApi, reconnectTransport } from '../agent/transport';
import type { Attachment } from '../attachment/types';
import { draftKey, removeDraft } from '../composer/drafts';
import { i18n } from '../i18n';
import { getConfigSelects, getConfigValues } from '../session/config-options';
import { completeThought, finishStreaming, reduceSessionEvent } from '../session/events';
import { getSortedSessionGroups } from '../session/groups';
import { cancelTurnPrompt, isPendingSessionCanceled, performTurn, setPendingSessionCanceled } from '../session/turn';
import type { DeckSession, SessionOptions, TextMessage } from '../session/types';
import { applyConfigSelection, getConfigDefaults, saveConfigDefaults, setAgentCommands } from './config-options';
import {
  clearAllInFlight,
  type InFlightSession,
  removeInFlight,
  saveInFlight,
  updateInFlightMessages,
} from './in-flight';
import { getSessionMeta, isSessionDeleted, markSessionDeleted, saveSessionMeta } from './session-meta';
import {
  agentdeckStore,
  clearSessionError,
  patchSession,
  setMessages,
  setPromptSuggestion,
  setSessionError,
  setSessionFlag,
  updateSessionOptions,
} from './store';
import { removeElicitations, settleUserInput, showElicitation, showPermission } from './user-input';

let sessionsRequest = 0;
const sessionLoads = new Map<string, number>();
const failedSessionLoads = new Set<string>();
const localSessions = new Map<string, DeckSession>();
const inFlightSessions = new Map<string, DeckSession>();
// The current turn rpcId for each pending session; used to discard waiting calls during reconciliation when ending turns
const turnRpcIds = new Map<string, string>();

export const recordInFlightSession = (session: DeckSession) => {
  inFlightSessions.set(session.sessionId, session);
  localSessions.set(session.sessionId, session);
};

// Sessions successfully opened during the app lifecycle (once opened, avoid repeated close+load)
const openedSessionIds = new Set<string>();

export const isSessionOpened = (sessionId: string) => openedSessionIds.has(sessionId);

export const applySessionEvent = (sessionId: string, event: SessionEvent) => {
  const current = agentdeckStore.messagesBySession[sessionId] ?? [];
  const streaming = agentdeckStore.pendingSessionIds.includes(sessionId);
  const options = agentdeckStore.optionsBySession[sessionId];
  const agent = getSession(sessionId)?.agent ?? agentdeckStore.settings.agent;
  const reduction = reduceSessionEvent(current, event, { agent, streaming, options });
  if (!reduction) return;
  if (reduction.messages) {
    setMessages(sessionId, reduction.messages);
    if (streaming) {
      updateInFlightMessages(sessionId, reduction.messages);
    }
  }
  if (reduction.sessionPatch) {
    patchSession(sessionId, reduction.sessionPatch);
    const local = localSessions.get(sessionId);
    if (local) localSessions.set(sessionId, { ...local, ...reduction.sessionPatch });
    const inFlight = inFlightSessions.get(sessionId);
    if (inFlight) inFlightSessions.set(sessionId, { ...inFlight, ...reduction.sessionPatch });
  }
  if (reduction.optionsPatch) updateSessionOptions(sessionId, reduction.optionsPatch);
  if (reduction.commands) setAgentCommands(agent, reduction.commands);
};

/** Permission requests and questions are shown only for the running turn of the device that started it. */
export const showUserInput = ({ method, params }: UserInput) => {
  if (getSession(params.sessionId)?.agent !== params.agent) return;
  if (method === 'agent_permission_request') showPermission(params);
  else showElicitation(params);
};

export const resetRemoteState = () => {
  sessionsRequest += 1;
  sessionLoads.clear();
  failedSessionLoads.clear();
  localSessions.clear();
  inFlightSessions.clear();
  openedSessionIds.clear();
  clearAllInFlight();
  agentdeckStore({
    pendingSession: null,
    sessions: [],
    sessionGroups: [],
    sessionsLoading: false,
    sessionsLoaded: false,
    sessionsError: '',
    deletingSessionIds: [],
    messagesBySession: {},
    loadedSessionIds: [],
    loadingSessionIds: [],
    pendingSessionIds: [],
    unreadSessionIds: [],
    errorsBySession: {},
    optionsBySession: {},
    permissionsBySession: {},
    elicitationsBySession: {},
  });
};

export const mergeSessionsWithInFlight = (
  remoteSessions: DeckSession[],
  inFlightList: Iterable<DeckSession>,
): DeckSession[] => {
  const remoteMap = new Map(remoteSessions.map((s) => [s.sessionId, s]));
  const merged: DeckSession[] = [...remoteSessions];

  for (const inFlight of inFlightList) {
    const activeUpdatedAt = inFlight.updatedAt || new Date().toISOString();
    const activeSession: DeckSession = { ...inFlight, updatedAt: activeUpdatedAt };
    const existing = remoteMap.get(inFlight.sessionId);
    if (existing) {
      const localTime = Date.parse(activeUpdatedAt) || 0;
      const remoteTime = Date.parse(existing.updatedAt || '') || 0;
      const index = merged.findIndex((s) => s.sessionId === inFlight.sessionId);
      if (index !== -1) {
        merged[index] = {
          ...existing,
          ...activeSession,
          updatedAt: localTime >= remoteTime ? activeUpdatedAt : existing.updatedAt,
        };
      }
    } else {
      merged.unshift(activeSession);
    }
  }

  return merged;
};

export const isPlaceholderTitle = (title?: string) => {
  const lower = title?.trim().toLowerCase();
  if (!lower) return true;

  // Generic untitled / default titles
  if (
    lower === 'untitled' ||
    lower === 'untitled session' ||
    lower === 'default session' ||
    lower === '未命名' ||
    lower === '未命名会话' ||
    lower === '新建会话'
  ) {
    return true;
  }

  // Matches "Session", "Session 123", "Session #1", "Session: <id>", "Session <hex/uuid>"
  if (/^session([:_\s#-]+([0-9a-f]{4,}(-?[0-9a-f]+)*|\d+))?$/i.test(lower)) {
    return true;
  }

  return false;
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
    const sessions = await agentApi.listSessions(agent);
    if (request !== sessionsRequest || agent !== agentdeckStore.settings.agent) return;
    const normalized = sessions
      .filter((session) => typeof session.sessionId === 'string' && typeof session.cwd === 'string')
      .filter((session) => !isSessionDeleted(session.sessionId))
      .map((session) => {
        const meta = getSessionMeta(session.sessionId);
        const title = isPlaceholderTitle(session.title) && meta?.title ? meta.title : session.title || meta?.title;
        return {
          ...session,
          agent,
          title,
          updatedAt: session.updatedAt || meta?.updatedAt,
        };
      });
    const merged = mergeSessionsWithInFlight(normalized, inFlightSessions.values());
    const prevGroups = agentdeckStore.sessionsLoaded ? agentdeckStore.sessionGroups : [];
    const groups = getSortedSessionGroups(merged, prevGroups);
    agentdeckStore({
      sessions: merged,
      sessionGroups: groups,
      sessionsLoaded: true,
      sessionsLoading: false,
    });
    for (const sessionId of Array.from(inFlightSessions.keys())) {
      if (!agentdeckStore.pendingSessionIds.includes(sessionId)) {
        inFlightSessions.delete(sessionId);
      }
    }
  } catch (error) {
    if (request !== sessionsRequest) return;
    let fallbackSessions = agentdeckStore.sessions;
    let fallbackGroups = agentdeckStore.sessionGroups;
    if (!agentdeckStore.sessionsLoaded && inFlightSessions.size > 0) {
      fallbackSessions = Array.from(inFlightSessions.values());
      fallbackGroups = getSortedSessionGroups(fallbackSessions, []);
    }
    agentdeckStore({
      sessions: fallbackSessions,
      sessionGroups: fallbackGroups,
      sessionsLoading: false,
      sessionsLoaded: true,
      sessionsError: error instanceof Error ? error.message : i18n.get('error.fetchSessionsFailed'),
    });
  }
};

export const getSession = (sessionId: string) => {
  if (sessionId === 'pending-session') return agentdeckStore.pendingSession ?? undefined;
  const remote = agentdeckStore.sessions.find((session) => session.sessionId === sessionId);
  if (remote) return remote;
  const agent = agentdeckStore.settings.agent;
  return localSessions.get(sessionId) && agent ? localSessions.get(sessionId) : undefined;
};

export const deleteSession = async (sessionId: string) => {
  const session = getSession(sessionId);
  if (!session || session.pendingCreation || agentdeckStore.deletingSessionIds.includes(sessionId)) return;
  if (agentdeckStore.connection !== 'connected') {
    Toast.open('error', i18n.get('error.remoteNotConnected'));
    return;
  }
  const { agent, relayId, relayUrl } = agentdeckStore.settings;
  const isCurrentHost = () =>
    agent === agentdeckStore.settings.agent &&
    relayId === agentdeckStore.settings.relayId &&
    relayUrl === agentdeckStore.settings.relayUrl;
  setSessionFlag('deletingSessionIds', sessionId, true);
  try {
    agentApi.deleteSession(session.agent, sessionId).catch(() => {});
    await TapSwipeoutElement.activeSwipeout?.dismiss();

    if (!isCurrentHost()) return;

    markSessionDeleted(sessionId);

    // A list request started before deletion must not restore the removed row.
    sessionsRequest += 1;
    sessionLoads.delete(sessionId);
    failedSessionLoads.delete(sessionId);
    localSessions.delete(sessionId);
    inFlightSessions.delete(sessionId);
    openedSessionIds.delete(sessionId);
    removeInFlight(sessionId);
    removeDraft(draftKey(session)).catch(console.error);
    settleUserInput(sessionId);
    removeElicitations(sessionId);
    const sessions = agentdeckStore.sessions.filter((item) => item.sessionId !== sessionId);
    const messagesBySession = { ...agentdeckStore.messagesBySession };
    const errorsBySession = { ...agentdeckStore.errorsBySession };
    const optionsBySession = { ...agentdeckStore.optionsBySession };
    delete messagesBySession[sessionId];
    delete errorsBySession[sessionId];
    delete optionsBySession[sessionId];
    agentdeckStore({
      sessions,
      sessionGroups: getSortedSessionGroups(sessions, agentdeckStore.sessionGroups),
      sessionsLoading: false,
      messagesBySession,
      errorsBySession,
      optionsBySession,
      loadedSessionIds: agentdeckStore.loadedSessionIds.filter((id) => id !== sessionId),
      loadingSessionIds: agentdeckStore.loadingSessionIds.filter((id) => id !== sessionId),
      pendingSessionIds: agentdeckStore.pendingSessionIds.filter((id) => id !== sessionId),
      unreadSessionIds: agentdeckStore.unreadSessionIds.filter((id) => id !== sessionId),
    });
  } catch (error) {
    if (isCurrentHost()) {
      Toast.open('error', error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (isCurrentHost()) setSessionFlag('deletingSessionIds', sessionId, false);
  }
};

export const closeSession = async (sessionId: string) => {
  const session = getSession(sessionId);
  sessionLoads.delete(sessionId);
  failedSessionLoads.delete(sessionId);
  openedSessionIds.delete(sessionId);
  inFlightSessions.delete(sessionId);
  setSessionFlag('loadedSessionIds', sessionId, false);
  setSessionFlag('loadingSessionIds', sessionId, false);
  setSessionFlag('pendingSessionIds', sessionId, false);
  setSessionFlag('unreadSessionIds', sessionId, false);
  settleUserInput(sessionId);
  removeInFlight(sessionId);
  setMessages(sessionId, finishStreaming(agentdeckStore.messagesBySession[sessionId] ?? []));
  clearSessionError(sessionId);

  if (session?.pendingCreation || sessionId === 'pending-session') {
    setPendingSessionCanceled(true);
    resetPendingSession();
    return;
  }

  if (session && agentdeckStore.connection === 'connected') {
    try {
      await agentApi.closeSession(session.agent, sessionId);
    } catch (error) {
      console.error(error);
    }
  }
};

export type CreateSessionInput = {
  agent: string;
  cwd: string;
};

export const createPendingSession = ({ agent, cwd }: CreateSessionInput): DeckSession => {
  const pendingSession: DeckSession = {
    agent,
    sessionId: 'pending-session',
    cwd,
    title: i18n.get('session.newSession'),
    pendingCreation: true,
    updatedAt: new Date().toISOString(),
  };
  localSessions.delete('pending-session');
  setMessages('pending-session', []);
  setSessionError('pending-session', '');
  setSessionFlag('loadingSessionIds', 'pending-session', false);
  setSessionFlag('pendingSessionIds', 'pending-session', false);
  setSessionFlag('loadedSessionIds', 'pending-session', true);
  agentdeckStore({
    pendingSession,
    optionsBySession: { ...agentdeckStore.optionsBySession, 'pending-session': getConfigDefaults(agent) },
  });
  return pendingSession;
};

export const resetPendingSession = () => {
  if (!agentdeckStore.pendingSession) return;
  setMessages('pending-session', []);
  setSessionError('pending-session', '');
  setSessionFlag('loadingSessionIds', 'pending-session', false);
  setSessionFlag('pendingSessionIds', 'pending-session', false);
  setSessionFlag('loadedSessionIds', 'pending-session', false);
  agentdeckStore({ pendingSession: null });
};

/**
 * Core runtime rules:
 * Once a session is opened, it does not need to be closed or repeat close+load session.
 * Only on first entry after app restart (when openedSessionIds is empty) does it run through close + load.
 */
export const ensureSessionLoaded = async (sessionId: string) => {
  if (sessionId === 'pending-session') return;
  if (openedSessionIds.has(sessionId)) {
    // Already opened; keep in memory for instant access, never repeat close + load
    return;
  }
  if (agentdeckStore.pendingSessionIds.includes(sessionId)) {
    openedSessionIds.add(sessionId);
    setSessionFlag('loadedSessionIds', sessionId, true);
    return;
  }
  if (agentdeckStore.loadingSessionIds.includes(sessionId)) return;
  if (failedSessionLoads.has(sessionId)) return;
  const session = getSession(sessionId);
  if (!session) return;
  if (agentdeckStore.connection !== 'connected') {
    failedSessionLoads.add(sessionId);
    setSessionError(sessionId, i18n.get('error.remoteNotConnected'));
    return;
  }

  const token = (sessionLoads.get(sessionId) ?? 0) + 1;
  sessionLoads.set(sessionId, token);
  setSessionFlag('loadingSessionIds', sessionId, true);
  setSessionError(sessionId, '');
  setMessages(sessionId, []);

  try {
    // First time entering session after restart: run close + load session
    await agentApi.closeSession(session.agent, sessionId);
    const loaded = await agentApi.loadSession({
      agent: session.agent,
      sessionId,
      cwd: session.cwd,
      onEvent: (event) => applySessionEvent(sessionId, event),
      panelContext: REMOTE_APP_PANEL_CONTEXT,
    });
    if (sessionLoads.get(sessionId) !== token) return;
    let loadedOptions: SessionOptions = { modes: loaded.modes, configOptions: loaded.configOptions ?? [] };
    const defaults = getConfigDefaults(session.agent);
    // Agents reset mode / model on load; re-apply the agent's saved selection
    if (getConfigSelects(defaults).length) {
      try {
        loadedOptions = await applyConfigSelection(session, loadedOptions, getConfigValues(defaults));
      } catch (error) {
        Toast.open('error', error instanceof Error ? error.message : i18n.get('error.switchConfigFailed'));
      }
      if (sessionLoads.get(sessionId) !== token) return;
    } else {
      // No selection saved for this agent yet: use the first loaded session as defaults for new sessions
      saveConfigDefaults(session.agent, loadedOptions);
    }
    failedSessionLoads.delete(sessionId);
    openedSessionIds.add(sessionId);
    setMessages(sessionId, finishStreaming(agentdeckStore.messagesBySession[sessionId] ?? []));
    setSessionFlag('loadingSessionIds', sessionId, false);
    setSessionFlag('loadedSessionIds', sessionId, true);
    updateSessionOptions(sessionId, loadedOptions);

    const meta = getSessionMeta(sessionId);
    const title = isPlaceholderTitle(loaded.title) && meta?.title ? meta.title : loaded.title || meta?.title;
    const updatedAt = loaded.updatedAt || meta?.updatedAt;
    patchSession(sessionId, {
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  } catch (error) {
    if (sessionLoads.get(sessionId) !== token) return;
    failedSessionLoads.add(sessionId);
    setSessionFlag('loadingSessionIds', sessionId, false);
    setSessionError(sessionId, error instanceof Error ? error.message : i18n.get('error.loadSessionFailed'));
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

const runPromptTurn = (
  session: DeckSession,
  prompt: TextMessage,
  turnStart: number,
  onFailed?: () => void,
  callId?: string,
) => {
  const now = new Date().toISOString();
  setSessionFlag('unreadSessionIds', session.sessionId, false);
  setSessionFlag('pendingSessionIds', session.sessionId, true);
  setSessionError(session.sessionId, '');
  setPromptSuggestion(session.sessionId, '');
  patchSession(session.sessionId, { updatedAt: now });
  const rpcId = callId ?? crypto.randomUUID();
  turnRpcIds.set(session.sessionId, rpcId);
  const currentMessages = agentdeckStore.messagesBySession[session.sessionId] ?? [];
  const activeSession: DeckSession = { ...session, updatedAt: now };
  recordInFlightSession(activeSession);
  saveInFlight({
    sessionId: session.sessionId,
    agent: session.agent,
    rpcId,
    session: activeSession,
    messages: currentMessages,
    options: agentdeckStore.optionsBySession[session.sessionId],
    updatedAt: Date.now(),
  });
  performTurn(
    session,
    prompt,
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
        removeInFlight(session.sessionId);
        setSessionError(session.sessionId, error);
        const messages = agentdeckStore.messagesBySession[session.sessionId] ?? [];
        setMessages(
          session.sessionId,
          messages.map((message) => (message.id === prompt.id ? { ...message, failed: true } : message)),
        );
        onFailed?.();
      },
      onDone: (completed) => {
        removeInFlight(session.sessionId);
        settleUserInput(session.sessionId);
        setMessages(session.sessionId, finishStreaming(agentdeckStore.messagesBySession[session.sessionId] ?? []));
        if (completed && agentdeckStore.pendingSessionIds.includes(session.sessionId)) {
          setSessionFlag('unreadSessionIds', session.sessionId, true);
        }
        setSessionFlag('pendingSessionIds', session.sessionId, false);
      },
    },
    rpcId,
  );
};

export const resumeInFlightTurn = (inFlight: InFlightSession) => {
  const { sessionId, rpcId, session } = inFlight;
  localSessions.set(sessionId, session);
  openedSessionIds.add(sessionId);
  turnRpcIds.set(sessionId, rpcId);
  agentApi.resumePrompt(rpcId, {
    onEvent: (event) => applySessionEvent(sessionId, event),
    resolve: (result) => {
      removeInFlight(sessionId);
      settleUserInput(sessionId);
      if (result?.answer) {
        const current = agentdeckStore.messagesBySession[sessionId] ?? [];
        const hasAnswer = current.some((m) => 'role' in m && m.role === 'agent' && m.text);
        if (!hasAnswer) {
          setMessages(sessionId, [...current, { id: crypto.randomUUID(), role: 'agent', text: result.answer }]);
        }
      }
      setMessages(sessionId, finishStreaming(agentdeckStore.messagesBySession[sessionId] ?? []));
      if (agentdeckStore.pendingSessionIds.includes(sessionId)) {
        setSessionFlag('unreadSessionIds', sessionId, true);
      }
      setSessionFlag('pendingSessionIds', sessionId, false);
    },
    reject: (error) => {
      removeInFlight(sessionId);
      setSessionError(sessionId, error.message);
      setSessionFlag('pendingSessionIds', sessionId, false);
      setMessages(sessionId, finishStreaming(agentdeckStore.messagesBySession[sessionId] ?? []));
    },
  });
};

/**
 * Relay drops messages unacknowledged for a long time, so a turn's final response may never arrive.
 * Reconcile after connecting to host: turns still pending locally whose daemon task is no longer running are ended immediately and history is reloaded.
 */
export const settleLostTurns = async () => {
  if (!agentdeckStore.pendingSessionIds.some((sessionId) => turnRpcIds.has(sessionId))) return;
  const { sessions, userInputs = [] } = await agentApi.listRunningPrompts();
  const running = new Set(sessions.map((session) => session.sessionId));
  // Responses prior to the query reply are already processed; any turns still pending whose daemon is no longer running are lost-reply turns
  for (const sessionId of agentdeckStore.pendingSessionIds) {
    const rpcId = turnRpcIds.get(sessionId);
    if (!rpcId || running.has(sessionId)) continue;
    // The final reply might still be in flight; forget this call to prevent it from landing on the reloaded timeline
    agentApi.forgetPrompt(rpcId);
    turnRpcIds.delete(sessionId);
    removeInFlight(sessionId);
    settleUserInput(sessionId);
    setSessionFlag('pendingSessionIds', sessionId, false);
    setSessionFlag('unreadSessionIds', sessionId, true);
    openedSessionIds.delete(sessionId);
    ensureSessionLoaded(sessionId);
  }
  // Permission requests and questions delivered before a reload are shown again.
  for (const input of userInputs) showUserInput(input);
};

export const promotePendingSession = async (
  pendingSession: DeckSession,
  text: string,
  attachments: Attachment[] = [],
  onFailed?: () => void,
  voiceChat?: boolean,
): Promise<DeckSession | null> => {
  if (agentdeckStore.connection !== 'connected') {
    setSessionError('pending-session', i18n.get('error.remoteNotConnectedCreate'));
    onFailed?.();
    return null;
  }
  const selectedOptions = agentdeckStore.optionsBySession['pending-session'] ?? {};
  setPendingSessionCanceled(false);
  const userMessage: TextMessage = { id: crypto.randomUUID(), role: 'user', text, attachments, voiceChat };
  setMessages('pending-session', [userMessage]);
  setSessionFlag('pendingSessionIds', 'pending-session', true);
  setSessionError('pending-session', '');

  let created: CreatedSession;
  try {
    created = await agentApi.createSession({
      agent: pendingSession.agent,
      cwd: pendingSession.cwd,
      panelContext: REMOTE_APP_PANEL_CONTEXT,
    });
    if (typeof created.sessionId !== 'string' || !created.sessionId) {
      throw new Error(i18n.get('error.missingSessionId'));
    }
  } catch (error) {
    setMessages('pending-session', []);
    setSessionFlag('pendingSessionIds', 'pending-session', false);
    setSessionError('pending-session', error instanceof Error ? error.message : i18n.get('error.createSessionFailed'));
    onFailed?.();
    return null;
  }

  const sessionId = created.sessionId;
  if (isPendingSessionCanceled()) {
    agentApi.closeSession(pendingSession.agent, sessionId).catch(() => {});
    setMessages('pending-session', []);
    setSessionFlag('pendingSessionIds', 'pending-session', false);
    return null;
  }

  const now = new Date().toISOString();
  const createdTitle = isPlaceholderTitle(created.title) ? undefined : created.title;
  const liveSession: DeckSession = {
    agent: pendingSession.agent,
    sessionId,
    cwd: pendingSession.cwd,
    title: createdTitle || text.slice(0, 30) || attachments[0]?.name,
    updatedAt: typeof created.updatedAt === 'string' && created.updatedAt ? created.updatedAt : now,
  };
  saveSessionMeta(sessionId, {
    title: liveSession.title,
    updatedAt: liveSession.updatedAt,
  });

  let options: SessionOptions = { modes: created.modes, configOptions: created.configOptions };
  let configError = '';
  try {
    options = await applyConfigSelection(liveSession, options, getConfigValues(selectedOptions));
    saveConfigDefaults(liveSession.agent, options);
  } catch (error) {
    configError = error instanceof Error ? error.message : i18n.get('error.switchConfigFailed');
  }
  if (isPendingSessionCanceled()) {
    agentApi.closeSession(pendingSession.agent, sessionId).catch(() => {});
    setMessages('pending-session', []);
    setSessionFlag('pendingSessionIds', 'pending-session', false);
    return null;
  }
  updateSessionOptions(sessionId, options);

  localSessions.set(liveSession.sessionId, liveSession);
  recordInFlightSession(liveSession);
  openedSessionIds.add(liveSession.sessionId);
  const stagedMessages = agentdeckStore.messagesBySession['pending-session'] ?? [userMessage];
  const nextSessions = [liveSession, ...agentdeckStore.sessions.filter((s) => s.sessionId !== liveSession.sessionId)];

  agentdeckStore({
    sessions: nextSessions,
    sessionGroups: getSortedSessionGroups(nextSessions, agentdeckStore.sessionGroups),
    messagesBySession: { ...agentdeckStore.messagesBySession, [liveSession.sessionId]: stagedMessages },
  });
  setSessionFlag('loadedSessionIds', liveSession.sessionId, true);

  if (configError) {
    setMessages(sessionId, [{ ...userMessage, failed: true }]);
    setSessionError(sessionId, configError);
    onFailed?.();
  } else {
    runPromptTurn(liveSession, userMessage, stagedMessages.length, onFailed);
  }
  return liveSession;
};

export const sendPrompt = (
  sessionId: string,
  prompt: string,
  attachments: Attachment[] = [],
  onFailed?: () => void,
  voiceChat?: boolean,
) => {
  const text = prompt.trim();
  const session = getSession(sessionId);
  if (
    (!text && !attachments.length) ||
    !session ||
    session.pendingCreation ||
    agentdeckStore.connection !== 'connected' ||
    !agentdeckStore.loadedSessionIds.includes(sessionId) ||
    agentdeckStore.pendingSessionIds.includes(sessionId)
  ) {
    onFailed?.();
    return false;
  }
  const messages = completeThought(agentdeckStore.messagesBySession[sessionId] ?? []);
  const userMessage: TextMessage = { id: crypto.randomUUID(), role: 'user', text, attachments, voiceChat };
  setMessages(sessionId, [...messages, userMessage]);
  const turnStart = messages.length + 1;
  runPromptTurn(session, userMessage, turnStart, onFailed);
  return true;
};

export const cancelTurn = (sessionId: string) => {
  const session = getSession(sessionId);
  if (!session || !agentdeckStore.pendingSessionIds.includes(sessionId)) return;
  settleUserInput(sessionId);
  if (session.pendingCreation) {
    setPendingSessionCanceled(true);
    setSessionFlag('pendingSessionIds', sessionId, false);
    return;
  }
  cancelTurnPrompt(session).catch((error) => {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('error.cancelTaskFailed'));
    setSessionFlag('pendingSessionIds', sessionId, false);
    removeInFlight(sessionId);
    setMessages(sessionId, finishStreaming(agentdeckStore.messagesBySession[sessionId] ?? []));
  });
};

export const endSession = (sessionId: string) => {
  setSessionFlag('loadedSessionIds', sessionId, false);
  setSessionFlag('loadingSessionIds', sessionId, false);
  setSessionFlag('pendingSessionIds', sessionId, false);
  openedSessionIds.delete(sessionId);
  settleUserInput(sessionId);
  setSessionError(sessionId, i18n.get('error.remoteSessionEnded'));
  removeInFlight(sessionId);
};
