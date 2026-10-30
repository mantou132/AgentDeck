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
import { cancelTurnPrompt, performTurn } from '../session/turn';
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
  getMessages,
  getRuntime,
  isConnecting,
  isTurnRunning,
  messagesStore,
  patchSession,
  removeRuntime,
  runningSessionIds,
  sessionsStore,
  setMessages,
  updateRuntime,
  updateSessionOptions,
} from './store';
import { settleUserInput, showElicitation, showPermission } from './user-input';

let sessionsRequest = 0;
let loadRequest = 0;

export const isSessionOpened = (sessionId: string) => getRuntime(sessionId).load === 'loaded';

export const applySessionEvent = (sessionId: string, event: SessionEvent) => {
  const { turn, options } = getRuntime(sessionId);
  const streaming = Boolean(turn);
  const agent = getSession(sessionId)?.agent ?? agentdeckStore.settings.agent;
  const reduction = reduceSessionEvent(getMessages(sessionId), event, { agent, streaming, options });
  if (!reduction) return;
  if (reduction.messages) {
    setMessages(sessionId, reduction.messages);
    if (streaming) {
      updateInFlightMessages(sessionId, reduction.messages);
    }
  }
  if (reduction.sessionPatch) patchSession(sessionId, reduction.sessionPatch);
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
  clearAllInFlight();
  sessionsStore({
    sessions: [],
    sessionGroups: [],
    sessionsLoading: false,
    sessionsLoaded: false,
    sessionsError: '',
    runtimes: {},
  });
  messagesStore({ bySession: {} });
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

/** Created sessions with a running turn, which the remote list may not have yet. */
const runningLocalSessions = () =>
  Object.values(sessionsStore.runtimes).flatMap(({ session, turn }) =>
    session && turn && !session.pendingCreation ? [session] : [],
  );

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

/** Manual retry: restarts a stalled connection, but only hurries an automatic reconnect instead of restarting it. */
const reconnect = () => reconnectTransport(!isConnecting());

export const refreshSessions = async () => {
  if (agentdeckStore.connection !== 'connected') {
    reconnect();
    return;
  }
  const request = ++sessionsRequest;
  const agent = agentdeckStore.settings.agent;
  sessionsStore({ sessionsLoading: true, sessionsError: '' });
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
    const merged = mergeSessionsWithInFlight(normalized, runningLocalSessions());
    const prevGroups = sessionsStore.sessionsLoaded ? sessionsStore.sessionGroups : [];
    sessionsStore({
      sessions: merged,
      sessionGroups: getSortedSessionGroups(merged, prevGroups),
      sessionsLoaded: true,
      sessionsLoading: false,
    });
  } catch (error) {
    if (request !== sessionsRequest) return;
    let fallbackSessions = sessionsStore.sessions;
    let fallbackGroups = sessionsStore.sessionGroups;
    const running = runningLocalSessions();
    if (!sessionsStore.sessionsLoaded && running.length > 0) {
      fallbackSessions = running;
      fallbackGroups = getSortedSessionGroups(fallbackSessions, []);
    }
    sessionsStore({
      sessions: fallbackSessions,
      sessionGroups: fallbackGroups,
      sessionsLoading: false,
      sessionsLoaded: true,
      sessionsError: error instanceof Error ? error.message : i18n.get('error.fetchSessionsFailed'),
    });
  }
};

export const getSession = (sessionId: string): DeckSession | undefined =>
  sessionsStore.sessions.find((session) => session.sessionId === sessionId) ?? getRuntime(sessionId).session;

export const deleteSession = async (sessionId: string) => {
  const session = getSession(sessionId);
  if (!session || session.pendingCreation || getRuntime(sessionId).deleting) return;
  if (agentdeckStore.connection !== 'connected') {
    Toast.open('error', i18n.get('error.remoteNotConnected'));
    return;
  }
  const { agent, relayId, relayUrl } = agentdeckStore.settings;
  const isCurrentHost = () =>
    agent === agentdeckStore.settings.agent &&
    relayId === agentdeckStore.settings.relayId &&
    relayUrl === agentdeckStore.settings.relayUrl;
  updateRuntime(sessionId, { deleting: true });
  try {
    agentApi.deleteSession(session.agent, sessionId).catch(() => {});
    await TapSwipeoutElement.activeSwipeout?.dismiss();

    if (!isCurrentHost()) return;

    markSessionDeleted(sessionId);

    // A list request started before deletion must not restore the removed row.
    sessionsRequest += 1;
    removeInFlight(sessionId);
    removeDraft(draftKey(session)).catch(console.error);
    removeRuntime(sessionId);
    const sessions = sessionsStore.sessions.filter((item) => item.sessionId !== sessionId);
    sessionsStore({
      sessions,
      sessionGroups: getSortedSessionGroups(sessions, sessionsStore.sessionGroups),
      sessionsLoading: false,
    });
  } catch (error) {
    if (isCurrentHost()) {
      Toast.open('error', error instanceof Error ? error.message : String(error));
      updateRuntime(sessionId, { deleting: false });
    }
  }
};

export const closeSession = async (sessionId: string) => {
  const session = getSession(sessionId);
  if (session?.pendingCreation) {
    // A creation still in flight sees its turn gone and closes the created session.
    removeRuntime(sessionId);
    return;
  }
  settleUserInput(sessionId);
  removeInFlight(sessionId);
  setMessages(sessionId, finishStreaming(getMessages(sessionId)));
  updateRuntime(sessionId, { load: 'idle', loadToken: undefined, turn: undefined, unread: false, error: '' });

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
  const session: DeckSession = {
    agent,
    sessionId: `pending-${crypto.randomUUID()}`,
    cwd,
    title: i18n.get('session.newSession'),
    pendingCreation: true,
    updatedAt: new Date().toISOString(),
  };
  updateRuntime(session.sessionId, { session, load: 'loaded', options: getConfigDefaults(agent) });
  return session;
};

/** The page drops its pending session once it no longer shows it. */
export const discardPendingSession = (sessionId: string) => {
  if (getRuntime(sessionId).session?.pendingCreation) removeRuntime(sessionId);
};

/**
 * Core runtime rules:
 * Once a session is opened, it does not need to be closed or repeat close+load session.
 * Only on first entry after app restart does it run through close + load.
 */
export const ensureSessionLoaded = async (sessionId: string) => {
  const runtime = getRuntime(sessionId);
  // Loaded, loading, or failed until retried
  if (runtime.load !== 'idle') return;
  if (runtime.turn) {
    updateRuntime(sessionId, { load: 'loaded' });
    return;
  }
  const session = getSession(sessionId);
  if (!session) return;
  // Stays idle; the session page loads it once connected
  if (agentdeckStore.connection !== 'connected') return;

  const token = ++loadRequest;
  const isCurrent = () => getRuntime(sessionId).loadToken === token;
  updateRuntime(sessionId, { load: 'loading', loadToken: token, error: '' });
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
    if (!isCurrent()) return;
    let loadedOptions: SessionOptions = { modes: loaded.modes, configOptions: loaded.configOptions ?? [] };
    const defaults = getConfigDefaults(session.agent);
    // Agents reset mode / model on load; re-apply the agent's saved selection
    if (getConfigSelects(defaults).length) {
      try {
        loadedOptions = await applyConfigSelection(session, loadedOptions, getConfigValues(defaults));
      } catch (error) {
        Toast.open('error', error instanceof Error ? error.message : i18n.get('error.switchConfigFailed'));
      }
      if (!isCurrent()) return;
    } else {
      // No selection saved for this agent yet: use the first loaded session as defaults for new sessions
      saveConfigDefaults(session.agent, loadedOptions);
    }
    setMessages(sessionId, finishStreaming(getMessages(sessionId)));
    updateRuntime(sessionId, { load: 'loaded', options: { ...getRuntime(sessionId).options, ...loadedOptions } });

    const meta = getSessionMeta(sessionId);
    const title = isPlaceholderTitle(loaded.title) && meta?.title ? meta.title : loaded.title || meta?.title;
    const updatedAt = loaded.updatedAt || meta?.updatedAt;
    patchSession(sessionId, {
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  } catch (error) {
    if (!isCurrent()) return;
    updateRuntime(sessionId, {
      load: 'failed',
      error: error instanceof Error ? error.message : i18n.get('error.loadSessionFailed'),
    });
  }
};

export const retrySessionLoad = (sessionId: string) => {
  if (agentdeckStore.connection !== 'connected') {
    reconnect();
    return;
  }
  updateRuntime(sessionId, { load: 'idle', error: '' });
  return ensureSessionLoaded(sessionId);
};

/** Ends the local turn; a completed turn whose reply nobody saw yet is marked unread. */
const endTurn = (sessionId: string, completed: boolean) => {
  removeInFlight(sessionId);
  settleUserInput(sessionId);
  setMessages(sessionId, finishStreaming(getMessages(sessionId)));
  updateRuntime(sessionId, { turn: undefined, ...(completed && isTurnRunning(sessionId) ? { unread: true } : {}) });
};

const runPromptTurn = (
  session: DeckSession,
  prompt: TextMessage,
  turnStart: number,
  onFailed?: () => void,
  callId?: string,
) => {
  const { sessionId } = session;
  const now = new Date().toISOString();
  const rpcId = callId ?? crypto.randomUUID();
  const activeSession: DeckSession = { ...session, updatedAt: now };
  patchSession(sessionId, { updatedAt: now });
  updateRuntime(sessionId, { session: activeSession, turn: { rpcId }, unread: false, error: '', suggestion: '' });
  saveInFlight({
    sessionId,
    agent: session.agent,
    rpcId,
    session: activeSession,
    messages: getMessages(sessionId),
    options: getRuntime(sessionId).options,
    updatedAt: Date.now(),
  });
  performTurn(
    session,
    prompt,
    {
      onEvent: (event) => applySessionEvent(sessionId, event),
      onAnswer: (answer) => {
        const current = getMessages(sessionId);
        const receivedAgentText = current
          .slice(turnStart)
          .some((message) => 'role' in message && message.role === 'agent' && message.text);
        if (!receivedAgentText) {
          setMessages(sessionId, [...current, { id: crypto.randomUUID(), role: 'agent', text: answer }]);
        }
      },
      onError: (error) => {
        removeInFlight(sessionId);
        updateRuntime(sessionId, { error });
        setMessages(
          sessionId,
          getMessages(sessionId).map((message) => (message.id === prompt.id ? { ...message, failed: true } : message)),
        );
        onFailed?.();
      },
      onDone: (completed) => endTurn(sessionId, completed),
    },
    rpcId,
  );
};

/** Resumes waiting for a turn persisted before the App restarted. */
export const resumeInFlightTurn = ({ sessionId, rpcId, session, messages, options }: InFlightSession) => {
  updateRuntime(sessionId, {
    session,
    load: 'loaded',
    turn: { rpcId },
    options: options ?? getRuntime(sessionId).options,
  });
  setMessages(sessionId, messages);
  agentApi.resumePrompt(rpcId, {
    onEvent: (event) => applySessionEvent(sessionId, event),
    resolve: (result) => {
      if (result?.answer) {
        const current = getMessages(sessionId);
        const hasAnswer = current.some((m) => 'role' in m && m.role === 'agent' && m.text);
        if (!hasAnswer) {
          setMessages(sessionId, [...current, { id: crypto.randomUUID(), role: 'agent', text: result.answer }]);
        }
      }
      endTurn(sessionId, true);
    },
    reject: (error) => {
      removeInFlight(sessionId);
      updateRuntime(sessionId, { error: error.message, turn: undefined });
      setMessages(sessionId, finishStreaming(getMessages(sessionId)));
    },
  });
};

/**
 * Relay drops messages unacknowledged for a long time, so a turn's final response may never arrive.
 * Reconcile after connecting to host: turns still pending locally whose daemon task is no longer running are ended immediately and history is reloaded.
 */
export const settleLostTurns = async () => {
  if (!runningSessionIds().some((sessionId) => getRuntime(sessionId).turn?.rpcId)) return;
  const { sessions, userInputs = [] } = await agentApi.listRunningPrompts();
  const running = new Set(sessions.map((session) => session.sessionId));
  // Responses prior to the query reply are already processed; any turns still pending whose daemon is no longer running are lost-reply turns
  for (const sessionId of runningSessionIds()) {
    const rpcId = getRuntime(sessionId).turn?.rpcId;
    if (!rpcId || running.has(sessionId)) continue;
    // The final reply might still be in flight; forget this call to prevent it from landing on the reloaded timeline
    agentApi.forgetPrompt(rpcId);
    removeInFlight(sessionId);
    settleUserInput(sessionId);
    updateRuntime(sessionId, { turn: undefined, unread: true, load: 'idle' });
    ensureSessionLoaded(sessionId);
  }
  // Permission requests and questions delivered before a reload are shown again.
  for (const input of userInputs) showUserInput(input);
};

/**
 * Creates the remote session on the first send. The pending session stays until the page has switched to the
 * returned session and discards it, so the page never renders without a session.
 */
export const promotePendingSession = async (
  pendingSession: DeckSession,
  text: string,
  attachments: Attachment[] = [],
  onFailed?: () => void,
  voiceChat?: boolean,
): Promise<DeckSession | null> => {
  const pendingId = pendingSession.sessionId;
  if (agentdeckStore.connection !== 'connected') {
    updateRuntime(pendingId, { error: i18n.get('error.remoteNotConnectedCreate') });
    onFailed?.();
    return null;
  }
  const selectedOptions = getRuntime(pendingId).options ?? {};
  const userMessage: TextMessage = { id: crypto.randomUUID(), role: 'user', text, attachments, voiceChat };
  // Cancelling or closing drops this turn; a later send starts another one.
  const turn = {};
  const isCanceled = () => getRuntime(pendingId).turn !== turn;
  const clearCanceled = () => {
    if (pendingId in sessionsStore.runtimes) setMessages(pendingId, []);
  };
  setMessages(pendingId, [userMessage]);
  updateRuntime(pendingId, { turn, error: '' });

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
    if (!isCanceled()) {
      setMessages(pendingId, []);
      updateRuntime(pendingId, {
        turn: undefined,
        error: error instanceof Error ? error.message : i18n.get('error.createSessionFailed'),
      });
    }
    onFailed?.();
    return null;
  }

  const sessionId = created.sessionId;
  if (isCanceled()) {
    agentApi.closeSession(pendingSession.agent, sessionId).catch(() => {});
    clearCanceled();
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
  if (isCanceled()) {
    agentApi.closeSession(pendingSession.agent, sessionId).catch(() => {});
    clearCanceled();
    return null;
  }

  const nextSessions = [liveSession, ...sessionsStore.sessions.filter((s) => s.sessionId !== sessionId)];
  sessionsStore({
    sessions: nextSessions,
    sessionGroups: getSortedSessionGroups(nextSessions, sessionsStore.sessionGroups),
  });
  updateRuntime(sessionId, { session: liveSession, load: 'loaded', options });

  if (configError) {
    setMessages(sessionId, [{ ...userMessage, failed: true }]);
    updateRuntime(sessionId, { error: configError });
    onFailed?.();
  } else {
    setMessages(sessionId, [userMessage]);
    runPromptTurn(liveSession, userMessage, 1, onFailed);
  }
  return liveSession;
};

/** Fork `session` up to and including the agent message `messageId` and list the new session; it loads when opened. */
export const forkSession = async (session: DeckSession, messageId: string): Promise<DeckSession | null> => {
  if (agentdeckStore.connection !== 'connected') {
    Toast.open('error', i18n.get('error.remoteNotConnected'));
    return null;
  }
  let sessionId: string;
  try {
    ({ sessionId } = await agentApi.forkSession({ ...session, messageId }));
  } catch (error) {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('error.forkSessionFailed'));
    return null;
  }
  const forked: DeckSession = {
    agent: session.agent,
    sessionId,
    cwd: session.cwd,
    // Same title claude-agent-acp derives, so a list refresh keeps it.
    title: session.title && `${session.title} (fork)`,
    updatedAt: new Date().toISOString(),
  };
  saveSessionMeta(sessionId, { title: forked.title, updatedAt: forked.updatedAt });
  const sessions = [forked, ...sessionsStore.sessions];
  sessionsStore({ sessions, sessionGroups: getSortedSessionGroups(sessions, sessionsStore.sessionGroups) });
  return forked;
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
    getRuntime(sessionId).load !== 'loaded' ||
    isTurnRunning(sessionId)
  ) {
    onFailed?.();
    return false;
  }
  const messages = completeThought(getMessages(sessionId));
  const userMessage: TextMessage = { id: crypto.randomUUID(), role: 'user', text, attachments, voiceChat };
  setMessages(sessionId, [...messages, userMessage]);
  runPromptTurn(session, userMessage, messages.length + 1, onFailed);
  return true;
};

export const cancelTurn = (sessionId: string) => {
  const session = getSession(sessionId);
  if (!session || !isTurnRunning(sessionId)) return;
  settleUserInput(sessionId);
  if (session.pendingCreation) {
    updateRuntime(sessionId, { turn: undefined });
    return;
  }
  cancelTurnPrompt(session).catch((error) => {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('error.cancelTaskFailed'));
    removeInFlight(sessionId);
    updateRuntime(sessionId, { turn: undefined });
    setMessages(sessionId, finishStreaming(getMessages(sessionId)));
  });
};

export const endSession = (sessionId: string) => {
  settleUserInput(sessionId);
  removeInFlight(sessionId);
  updateRuntime(sessionId, { load: 'idle', turn: undefined, error: i18n.get('error.remoteSessionEnded') });
};
