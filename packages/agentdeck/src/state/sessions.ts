import { TapSwipeoutElement } from '@mantou/tap-ui/elements/swipeout';
import { Toast } from '@mantou/tap-ui/elements/toast';
import {
  type CreatedSession,
  REMOTE_APP_PANEL_CONTEXT,
  type SessionEvent,
  type SessionStateUpdate,
  type UserInput,
} from 'src/agent/api';
import { RpcError } from 'src/agent/rpc';
import { agentApi, reconnectTransport } from 'src/agent/transport';
import { toPromptAttachment } from 'src/attachment/prompt';
import type { Attachment } from 'src/attachment/types';
import { draftKey, removeDraft } from 'src/composer/drafts';
import { i18n } from 'src/i18n';
import { getConfigSelects, getConfigValues } from 'src/session/config-options';
import { completeThought, finishStreaming, reduceSessionEvent } from 'src/session/events';
import { getSortedSessionGroups } from 'src/session/groups';
import type { DeckSession, SessionOptions, Subagent, TextMessage } from 'src/session/types';
import {
  applyConfigSelection,
  getConfigDefaults,
  saveConfigDefaults,
  setAgentCommands,
} from 'src/state/config-options';
import {
  agentdeckStore,
  getMessages,
  getRuntime,
  hostAgents,
  isConnecting,
  isTurnRunning,
  messagesStore,
  patchSession,
  removeRuntime,
  runningSessionIds,
  sessionsStore,
  sessionTreeIds,
  setMessages,
  updateRuntime,
  updateSessionOptions,
} from 'src/state/store';
import { clearTaskPermission, getRunningTask, showTaskPermission } from 'src/state/tasks';
import {
  clearUserInput,
  replaceSessionUserInputs,
  settleUserInput,
  showElicitation,
  showPermission,
} from 'src/state/user-input';

/** Banner text for a failed prompt; an agent whose login expired gets a sign-in hint. */
const formatTurnError = (message: string, code?: string) =>
  code === 'auth_required' ? i18n.get('error.agentAuthRequired') : message;

const promptErrorMessage = (error: unknown) => {
  if (error instanceof RpcError) return formatTurnError(error.message, error.code);
  return error instanceof Error ? error.message : i18n.get('error.sendMessageFailed');
};

const sendTurnPrompt = (
  session: DeckSession,
  { id, text, attachments = [], voiceChat }: Pick<TextMessage, 'id' | 'text' | 'attachments' | 'voiceChat'>,
) =>
  agentApi.prompt({
    agent: session.agent,
    sessionId: session.sessionId,
    prompt: text,
    attachments: attachments.map(toPromptAttachment),
    voiceChat,
    clientMessageId: id,
  });

const cancelTurnPrompt = async (session: DeckSession, childSessionId?: string) => {
  const result = await agentApi.cancelPrompt(session.sessionId, session.agent, childSessionId);
  if (result.cancelled === false) {
    throw new Error(i18n.get('error.cannotStopTask'));
  }
};

let sessionsRequest = 0;
let loadRequest = 0;
let remoteGeneration = 0;
let createRequest = 0;

/** Sessions with an `openSession` RPC in flight, buffering live `agent_session_event` notifications until it settles. */
const pendingOpenEvents = new Map<string, Array<{ epoch: string; event: SessionEvent }>>();
/** Client message IDs rendered optimistically on this device, used to dedupe echoed `user_message_chunk`s. */
const optimisticMessageIds = new Map<string, Set<string>>();
/** Pending-session creation tokens, invalidated if creation is cancelled or closed. */
const creatingTokens = new Map<string, number>();
/** Refcount of mounted session pages viewing each session id (used for reconnect resync & unsubscribe). */
const openPages = new Map<string, number>();

const clearSessionTransient = (sessionId: string) => {
  pendingOpenEvents.delete(sessionId);
  optimisticMessageIds.delete(sessionId);
  creatingTokens.delete(sessionId);
};

const finishSessionTree = (sessionId: string) => {
  for (const id of sessionTreeIds(sessionId)) {
    setMessages(id, finishStreaming(getMessages(id)));
  }
};

/** Subagent `childSessionId` of `sessionId` was announced, or what is known about it changed. */
const applySubagentUpdate = (sessionId: string, childSessionId: string, patch: Partial<Subagent>) => {
  const { subagents } = getRuntime(sessionId);
  updateRuntime(sessionId, {
    subagents: { ...subagents, [childSessionId]: { ...subagents?.[childSessionId], ...patch } },
  });
  // The host has cancelled its requests.
  if (patch.state?.state === 'idle' && patch.state.stopReason === 'cancelled')
    settleUserInput(sessionId, childSessionId);
};

/**
 * Applies one reduced event to the message timeline and runtime metadata.
 * Updates of subagents (`childSessionId`, nested ones too) are kept under their own session id and belong to
 * the root session `sessionId`: they never change its session, options or commands.
 */
const applyReducedEvent = (sessionId: string, event: SessionEvent, streaming: boolean) => {
  const subagentId = event.event === 'session_update' ? event.childSessionId : undefined;
  const target = subagentId || sessionId;
  const { options } = getRuntime(sessionId);
  const agent = getSession(sessionId)?.agent ?? agentdeckStore.settings.agent;
  const reduction = reduceSessionEvent(getMessages(target), event, {
    agent,
    streaming,
    options,
    subagentId,
    optimisticMessageIds: subagentId ? undefined : optimisticMessageIds.get(sessionId),
  });
  if (!reduction) return;
  if (reduction.messages) {
    setMessages(target, reduction.messages);
  }
  if (reduction.subagent) applySubagentUpdate(sessionId, reduction.subagent.sessionId, reduction.subagent.patch);
  if (subagentId) return;
  if (reduction.sessionPatch) patchSession(sessionId, reduction.sessionPatch);
  if (reduction.optionsPatch) updateSessionOptions(sessionId, reduction.optionsPatch);
  if (reduction.commands) setAgentCommands(agent, reduction.commands);
};

/** Public helper for applying a live `agent_session_event` notification from the daemon. */
export const handleSessionEvent = (sessionId: string, epoch: string, event: SessionEvent) => {
  const buffer = pendingOpenEvents.get(sessionId);
  if (buffer) {
    buffer.push({ epoch, event });
    return;
  }
  const runtime = getRuntime(sessionId);
  if (!runtime.subscribed) return;
  if (runtime.epoch && runtime.epoch !== epoch) {
    ensureSessionLoaded(sessionId, { force: true });
    return;
  }
  if (runtime.lastSeq !== undefined && event.seq <= runtime.lastSeq) return;
  if (runtime.epoch === epoch && runtime.lastSeq !== undefined && event.seq > runtime.lastSeq + 1) {
    ensureSessionLoaded(sessionId, { force: true });
    return;
  }

  if (event.event === 'turn_started') {
    applyReducedEvent(sessionId, event, true);
    updateRuntime(sessionId, { epoch, lastSeq: event.seq, running: true, error: '', suggestion: '' });
    return;
  }
  if (event.event === 'turn_ended') {
    finishSessionTree(sessionId);
    settleUserInput(sessionId);
    const completed = !event.error && event.stopReason !== 'cancelled';
    updateRuntime(sessionId, {
      epoch,
      lastSeq: event.seq,
      running: false,
      ...(event.error ? { error: formatTurnError(event.error, event.code) } : {}),
      ...(completed ? { unread: true } : {}),
    });
    return;
  }
  applyReducedEvent(sessionId, event, Boolean(runtime.running));
  updateRuntime(sessionId, { epoch, lastSeq: event.seq });
};

/** Applies a broadcast `agent_session_state` notification (turn start/end or metadata change). */
export const handleSessionState = (state: SessionStateUpdate) => {
  const { sessionId, agent, title, updatedAt } = state;
  if (getRunningTask(sessionId)) return;

  const prev = getRuntime(sessionId);
  const existing = getSession(sessionId);

  if (!existing && agent === agentdeckStore.settings.agent && state.cwd) {
    const nextSession: DeckSession = {
      agent,
      sessionId,
      cwd: state.cwd,
      title,
      updatedAt: updatedAt || new Date().toISOString(),
    };
    const nextSessions = mergeSessionsWithActive(sessionsStore.sessions, [nextSession]);
    sessionsStore({
      sessions: nextSessions,
      sessionGroups: getSortedSessionGroups(nextSessions, sessionsStore.sessionGroups),
    });
    updateRuntime(sessionId, { session: nextSession });
  } else if (existing && (title || updatedAt)) {
    patchSession(sessionId, {
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }

  // Subscribed sessions receive turn_started / turn_ended on the sequenced event stream;
  // applying unsequenced state broadcasts here can re-mark unread or race with a newly started turn.
  if (prev.subscribed) return;

  if (!state.running) {
    settleUserInput(sessionId);
    finishSessionTree(sessionId);
  }

  updateRuntime(sessionId, {
    running: state.running,
    ...(state.completed ? { unread: true } : {}),
    ...(state.error
      ? { error: formatTurnError(state.error, state.code) }
      : state.running
        ? { error: '', suggestion: '' }
        : {}),
  });
};

/** Cancel subagent `childSessionId`'s current work; the agent reports it `idle` / `cancelled` when it stopped. */
export const cancelSubagent = async (sessionId: string, childSessionId: string) => {
  const session = getSession(sessionId);
  if (!session) return;
  try {
    await cancelTurnPrompt(session, childSessionId);
  } catch (error) {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('error.cancelTaskFailed'));
  }
};

/** Shows a broadcast permission request or elicitation on the matching task or session. */
export const showUserInput = ({ method, params }: UserInput) => {
  if (method === 'agent_permission_request' && showTaskPermission(params)) return;
  const session = getSession(params.sessionId);
  if (session && session.agent !== params.agent) return;
  if (!session && params.agent !== agentdeckStore.settings.agent) return;
  if (method === 'agent_permission_request') showPermission(params);
  else showElicitation(params);
};

/** Dismisses a permission request or elicitation answered on another device or cancelled by the host. */
export const handleUserInputResolved = (sessionId: string, requestId: string) => {
  clearTaskPermission(requestId);
  clearUserInput(sessionId, requestId);
};

/** Marks all local subscriptions stale when the connection leaves `connected`. */
export const markAllUnsubscribed = () => {
  let changed = false;
  const runtimes = { ...sessionsStore.runtimes };
  for (const [sessionId, runtime] of Object.entries(runtimes)) {
    if (runtime.subscribed) {
      runtimes[sessionId] = { ...runtime, subscribed: false };
      changed = true;
    }
  }
  if (changed) sessionsStore({ runtimes });
};

export const resetRemoteState = () => {
  sessionsRequest += 1;
  loadRequest += 1;
  remoteGeneration += 1;
  pendingOpenEvents.clear();
  optimisticMessageIds.clear();
  creatingTokens.clear();
  openPages.clear();
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

/** Switching agents on the same host only swaps the list; runtimes keep tracking turns still running. */
export const resetSessionList = () => {
  sessionsRequest += 1;
  sessionsStore({ sessions: [], sessionGroups: [], sessionsLoading: false, sessionsLoaded: false, sessionsError: '' });
};

export const mergeSessionsWithActive = (
  remoteSessions: DeckSession[],
  activeList: Iterable<DeckSession>,
): DeckSession[] => {
  const remoteMap = new Map(remoteSessions.map((s) => [s.sessionId, s]));
  const merged: DeckSession[] = [...remoteSessions];

  for (const active of activeList) {
    const activeUpdatedAt = active.updatedAt || new Date().toISOString();
    const activeSession: DeckSession = { ...active, updatedAt: activeUpdatedAt };
    const existing = remoteMap.get(active.sessionId);
    if (existing) {
      const localTime = Date.parse(activeUpdatedAt) || 0;
      const remoteTime = Date.parse(existing.updatedAt || '') || 0;
      const index = merged.findIndex((s) => s.sessionId === active.sessionId);
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

/** Created or active sessions with a running turn, which the remote list may not have yet. */
const runningLocalSessions = () =>
  Object.values(sessionsStore.runtimes).flatMap(({ session, running }) =>
    session && running && !session.pendingCreation && session.agent === agentdeckStore.settings.agent ? [session] : [],
  );

agentApi.setAgentStatusHandler((agent, status) => {
  const { [agent]: _, ...rest } = sessionsStore.agentStatus;
  sessionsStore({ agentStatus: status ? { ...rest, [agent]: status } : rest });
});

/** What the host is doing with `agent` before a session call can run, or `''`. */
export const getAgentStatusText = (agent: string) => {
  const status = sessionsStore.agentStatus[agent];
  if (!status) return '';
  const name = hostAgents().find((item) => item.id === agent)?.name || agent;
  return i18n.get(status === 'installing' ? 'agentStatus.installing' : 'agentStatus.starting', name);
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
    const valid = sessions.filter(
      (session) => typeof session.sessionId === 'string' && typeof session.cwd === 'string',
    );
    const normalized = valid.map(({ unread: _, ...session }) => ({ ...session, agent }));
    const merged = mergeSessionsWithActive(normalized, runningLocalSessions());
    const prevGroups = sessionsStore.sessionsLoaded ? sessionsStore.sessionGroups : [];
    const runtimes = { ...sessionsStore.runtimes };
    let runtimesChanged = false;
    for (const session of valid) {
      if (isTurnRunning(session.sessionId)) continue;
      const nextUnread = Boolean(session.unread);
      const current = runtimes[session.sessionId];
      if (Boolean(current?.unread) !== nextUnread) {
        runtimes[session.sessionId] = { ...(current ?? { load: 'idle' }), unread: nextUnread };
        runtimesChanged = true;
      }
    }
    sessionsStore({
      sessions: merged,
      sessionGroups: getSortedSessionGroups(merged, prevGroups),
      sessionsLoaded: true,
      sessionsLoading: false,
      ...(runtimesChanged ? { runtimes } : {}),
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

/** Reconciles running sessions and pending user inputs against the daemon after connecting. */
export const syncActiveSessions = async () => {
  if (agentdeckStore.connection !== 'connected') return;
  const generation = remoteGeneration;
  const { sessions, userInputs = [] } = await agentApi.listActiveSessions();
  if (generation !== remoteGeneration) return;

  let settled = false;
  const activeIds = new Set(sessions.map((item) => item.sessionId));
  for (const sessionId of runningSessionIds()) {
    const runtime = getRuntime(sessionId);
    if (runtime.creating || activeIds.has(sessionId)) continue;
    settleUserInput(sessionId);
    finishSessionTree(sessionId);
    updateRuntime(sessionId, { running: false });
    settled = true;
  }

  const currentAgentActive: DeckSession[] = [];
  for (const active of sessions) {
    if (getRunningTask(active.sessionId)) continue;
    const { title, updatedAt } = active;
    const existing = getSession(active.sessionId);
    const session: DeckSession | undefined = existing
      ? { ...existing, ...(title ? { title } : {}), ...(updatedAt ? { updatedAt } : {}) }
      : active.cwd
        ? {
            agent: active.agent,
            sessionId: active.sessionId,
            cwd: active.cwd,
            title,
            updatedAt: updatedAt || new Date().toISOString(),
          }
        : undefined;
    updateRuntime(active.sessionId, { running: true, ...(session ? { session } : {}) });
    if (session && active.agent === agentdeckStore.settings.agent) {
      currentAgentActive.push(session);
    }
  }

  if (currentAgentActive.length) {
    const merged = mergeSessionsWithActive(sessionsStore.sessions, currentAgentActive);
    sessionsStore({
      sessions: merged,
      sessionGroups: getSortedSessionGroups(merged, sessionsStore.sessionGroups),
    });
  }

  for (const input of userInputs) showUserInput(input);
  // If `refreshSessions` already returned before we cleared a finished turn, re-fetch so its
  // daemon-persisted `unread` / `updatedAt` are not skipped by the `isTurnRunning` guard.
  if (settled && !sessionsStore.sessionsLoading) refreshSessions();
};

export const getSession = (sessionId: string): DeckSession | undefined =>
  sessionsStore.sessions.find((session) => session.sessionId === sessionId) ?? getRuntime(sessionId).session;

const removeSessionLocally = (sessionId: string) => {
  const session = getSession(sessionId);
  clearSessionTransient(sessionId);
  openPages.delete(sessionId);
  if (session) removeDraft(draftKey(session)).catch(console.error);
  removeRuntime(sessionId);
  const sessions = sessionsStore.sessions.filter((item) => item.sessionId !== sessionId);
  sessionsStore({
    sessions,
    sessionGroups: getSortedSessionGroups(sessions, sessionsStore.sessionGroups),
    sessionsLoading: false,
  });
};

/** Removes a session deleted on another device or by a scheduled task cleanup. */
export const handleSessionDeleted = (sessionId: string) => {
  if (!getSession(sessionId)) return;
  sessionsRequest += 1;
  removeSessionLocally(sessionId);
};

/** Applies an `agent_session_unread` broadcast from the daemon (synced across devices). */
export const handleSessionUnread = (agent: string, sessionId: string, unread: boolean) => {
  if (agent !== agentdeckStore.settings.agent) return;
  if (unread && isTurnRunning(sessionId)) return;
  if (Boolean(getRuntime(sessionId).unread) === unread) return;
  updateRuntime(sessionId, { unread });
};

/** Marks a session read or unread locally and persists the change on the daemon. */
export const setSessionUnread = (sessionId: string, unread: boolean) => {
  if (unread && isTurnRunning(sessionId)) return;
  updateRuntime(sessionId, { unread });
  const session = getSession(sessionId);
  if (session && !session.pendingCreation && agentdeckStore.connection === 'connected') {
    agentApi.setSessionUnread(session.agent, sessionId, unread).catch(() => {});
  }
};

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

    // A list request started before deletion must not restore the removed row.
    sessionsRequest += 1;
    removeSessionLocally(sessionId);
  } catch (error) {
    if (isCurrentHost()) {
      Toast.open('error', error instanceof Error ? error.message : String(error));
      updateRuntime(sessionId, { deleting: false });
    }
  }
};

/** Explicitly closes the session on the daemon (cancels any active turn and releases the actor). */
export const closeSession = async (sessionId: string) => {
  const session = getSession(sessionId);
  if (session?.pendingCreation) {
    // A creation still in flight sees its token gone and closes the created session.
    creatingTokens.delete(sessionId);
    removeRuntime(sessionId);
    return;
  }
  clearSessionTransient(sessionId);
  settleUserInput(sessionId);
  finishSessionTree(sessionId);
  updateRuntime(sessionId, {
    load: 'idle',
    loadToken: undefined,
    running: false,
    subscribed: false,
    epoch: undefined,
    lastSeq: undefined,
    unread: false,
    error: '',
  });

  if (session && agentdeckStore.connection === 'connected') {
    try {
      await agentApi.closeSession(session.agent, sessionId);
    } catch (error) {
      console.error(error);
    }
  }
};

/** Unsubscribes this device from live events of `sessionId` without closing or cancelling the remote session. */
export const unsubscribeSession = (sessionId: string) => {
  const runtime = getRuntime(sessionId);
  if (!runtime.subscribed) return;
  updateRuntime(sessionId, { subscribed: false });
  const session = getSession(sessionId);
  if (session && !session.pendingCreation && agentdeckStore.connection === 'connected') {
    agentApi.unsubscribeSession(session.agent, sessionId).catch(() => {});
  }
};

/** Tracks a mounted session page so reconnects resync it and unmounting unsubscribes it. */
export const trackSessionPage = (sessionId: string) => {
  if (!sessionId || sessionId.startsWith('pending-')) return () => {};
  openPages.set(sessionId, (openPages.get(sessionId) ?? 0) + 1);
  return () => {
    const next = (openPages.get(sessionId) ?? 1) - 1;
    if (next <= 0) {
      openPages.delete(sessionId);
      unsubscribeSession(sessionId);
    } else {
      openPages.set(sessionId, next);
    }
  };
};

/** Resubscribes and incrementally catches up every currently open session page after a reconnect. */
export const resyncOpenSessions = () => {
  for (const sessionId of openPages.keys()) {
    ensureSessionLoaded(sessionId, { force: true });
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
  if (getRuntime(sessionId).session?.pendingCreation) {
    creatingTokens.delete(sessionId);
    removeRuntime(sessionId);
  }
};

/**
 * Idempotently opens and subscribes to a session on the daemon.
 * - First open (or after `closeSession`): loads history and subscribes.
 * - Re-entering an unsubscribed session or reconnecting: sends `sinceEpoch`/`sinceSeq` to replay only missed events
 *   without wiping the timeline or cancelling any running turn.
 */
export const ensureSessionLoaded = async (sessionId: string, options?: { force?: boolean }) => {
  const force = Boolean(options?.force);
  const runtime = getRuntime(sessionId);
  if (!force && runtime.load === 'loaded' && runtime.subscribed) return;
  if (!force && (runtime.load === 'loading' || runtime.load === 'failed')) return;
  if (pendingOpenEvents.has(sessionId) && !force) return;

  const session = getSession(sessionId);
  if (!session || session.pendingCreation) return;
  if (agentdeckStore.connection !== 'connected') return;

  const token = ++loadRequest;
  const isCurrent = () => getRuntime(sessionId).loadToken === token;
  const tracked = openPages.has(sessionId);
  const hadLoaded = runtime.load === 'loaded';
  const sinceEpoch = hadLoaded ? runtime.epoch : undefined;
  const sinceSeq = hadLoaded && sinceEpoch ? (runtime.lastSeq ?? 0) : undefined;
  const wasRunning = Boolean(runtime.running);

  pendingOpenEvents.set(sessionId, []);

  if (!hadLoaded) {
    const ids = sessionTreeIds(sessionId);
    optimisticMessageIds.delete(sessionId);
    updateRuntime(sessionId, { load: 'loading', loadToken: token, error: '', subagents: undefined });
    for (const id of ids) setMessages(id, []);
  } else {
    updateRuntime(sessionId, { loadToken: token, error: '' });
  }

  const replayEvents: SessionEvent[] = [];
  try {
    const opened = await agentApi.openSession({
      agent: session.agent,
      sessionId,
      cwd: session.cwd,
      sinceEpoch,
      sinceSeq,
      onEvent: (event) => {
        if (isCurrent()) replayEvents.push(event);
      },
      panelContext: REMOTE_APP_PANEL_CONTEXT,
    });
    if (!isCurrent()) return;

    if (opened.fullReplay) {
      const ids = sessionTreeIds(sessionId);
      optimisticMessageIds.delete(sessionId);
      updateRuntime(sessionId, { subagents: undefined });
      for (const id of ids) setMessages(id, []);
    }

    let inTurn = opened.fullReplay ? false : wasRunning;
    let lastSeq = opened.fullReplay ? 0 : (sinceSeq ?? 0);
    let lastTurnError = '';

    for (const event of replayEvents) {
      if (event.seq <= lastSeq) continue;
      if (event.event === 'turn_started') {
        inTurn = true;
        lastTurnError = '';
      }
      applyReducedEvent(sessionId, event, inTurn);
      if (event.event === 'turn_ended') {
        inTurn = false;
        if (event.error) lastTurnError = formatTurnError(event.error, event.code);
      }
      lastSeq = event.seq;
    }

    lastSeq = Math.max(lastSeq, opened.seq ?? 0);
    let running = Boolean(opened.running);

    const buffered = (pendingOpenEvents.get(sessionId) ?? [])
      .filter((item) => item.epoch === opened.epoch && item.event.seq > lastSeq)
      .sort((a, b) => a.event.seq - b.event.seq);
    pendingOpenEvents.delete(sessionId);

    for (const { event } of buffered) {
      if (event.seq <= lastSeq) continue;
      if (event.event === 'turn_started') {
        running = true;
        lastTurnError = '';
      }
      applyReducedEvent(sessionId, event, running);
      if (event.event === 'turn_ended') {
        running = false;
        if (event.error) lastTurnError = formatTurnError(event.error, event.code);
      }
      lastSeq = event.seq;
    }

    if (!running) {
      finishSessionTree(sessionId);
    }

    let loadedOptions: SessionOptions = { modes: opened.modes, configOptions: opened.configOptions ?? [] };
    updateRuntime(sessionId, {
      subscribed: true,
      epoch: opened.epoch,
      lastSeq,
      running,
      suggestion: opened.suggestion ?? '',
      error: lastTurnError,
      options: { ...getRuntime(sessionId).options, ...loadedOptions },
    });
    replaceSessionUserInputs(sessionId, opened.userInputs ?? []);
    if (tracked && !openPages.has(sessionId)) {
      unsubscribeSession(sessionId);
    }

    patchSession(sessionId, {
      ...(opened.title ? { title: opened.title } : {}),
      ...(opened.updatedAt ? { updatedAt: opened.updatedAt } : {}),
    });

    // Agents reset mode / model on a fresh ACP `session/load`; re-apply the agent's saved selection only then.
    if (opened.freshLoad) {
      const defaults = getConfigDefaults(session.agent);
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
    }
    updateRuntime(sessionId, {
      load: 'loaded',
      options: { ...getRuntime(sessionId).options, ...loadedOptions },
    });
  } catch (error) {
    if (!isCurrent()) return;
    pendingOpenEvents.delete(sessionId);
    updateRuntime(sessionId, {
      load: hadLoaded ? 'loaded' : 'failed',
      subscribed: false,
      error: error instanceof Error ? error.message : i18n.get('error.loadSessionFailed'),
    });
  }
};

export const retrySessionLoad = (sessionId: string) => {
  if (agentdeckStore.connection !== 'connected') {
    reconnect();
    return;
  }
  const runtime = getRuntime(sessionId);
  if (runtime.load === 'failed') {
    updateRuntime(sessionId, { load: 'idle', error: '' });
  }
  return ensureSessionLoaded(sessionId, { force: true });
};

const recordOptimisticMessage = (sessionId: string, clientMessageId: string) => {
  let ids = optimisticMessageIds.get(sessionId);
  if (!ids) {
    ids = new Set();
    optimisticMessageIds.set(sessionId, ids);
  }
  ids.add(clientMessageId);
};

const startPromptOnSession = (session: DeckSession, userMessage: TextMessage, onFailed?: () => void) => {
  const { sessionId } = session;
  const now = new Date().toISOString();
  const activeSession: DeckSession = { ...session, updatedAt: now };
  patchSession(sessionId, { updatedAt: now });
  updateRuntime(sessionId, {
    session: activeSession,
    running: true,
    unread: false,
    error: '',
    suggestion: '',
  });
  sendTurnPrompt(session, userMessage).catch((error) => {
    optimisticMessageIds.get(sessionId)?.delete(userMessage.id);
    updateRuntime(sessionId, { running: false, error: promptErrorMessage(error) });
    setMessages(
      sessionId,
      getMessages(sessionId).map((message) => (message.id === userMessage.id ? { ...message, failed: true } : message)),
    );
    onFailed?.();
  });
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
  const token = ++createRequest;
  creatingTokens.set(pendingId, token);
  const isCanceled = () => creatingTokens.get(pendingId) !== token;
  const clearCanceled = () => {
    if (pendingId in sessionsStore.runtimes) setMessages(pendingId, []);
  };
  setMessages(pendingId, [userMessage]);
  updateRuntime(pendingId, { creating: true, error: '' });

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
      creatingTokens.delete(pendingId);
      setMessages(pendingId, []);
      updateRuntime(pendingId, {
        creating: false,
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
  const liveSession: DeckSession = {
    agent: pendingSession.agent,
    sessionId,
    cwd: pendingSession.cwd,
    title: created.title || text.slice(0, 30) || attachments[0]?.name,
    updatedAt: typeof created.updatedAt === 'string' && created.updatedAt ? created.updatedAt : now,
  };

  let options: SessionOptions = { modes: created.modes, configOptions: created.configOptions };
  // The daemon subscribed this device on `createSession`; track `(epoch, seq)` before applying config
  // so `current_mode_update` / `config_option_update` broadcasts advance `lastSeq` without triggering a gap resync.
  updateRuntime(sessionId, {
    session: liveSession,
    subscribed: true,
    epoch: created.epoch,
    lastSeq: created.seq ?? 0,
    options,
  });

  let configError = '';
  try {
    options = await applyConfigSelection(liveSession, options, getConfigValues(selectedOptions));
    saveConfigDefaults(liveSession.agent, options);
  } catch (error) {
    configError = error instanceof Error ? error.message : i18n.get('error.switchConfigFailed');
  }
  if (isCanceled()) {
    removeRuntime(sessionId);
    agentApi.closeSession(pendingSession.agent, sessionId).catch(() => {});
    clearCanceled();
    return null;
  }
  creatingTokens.delete(pendingId);

  const nextSessions = [liveSession, ...sessionsStore.sessions.filter((s) => s.sessionId !== sessionId)];
  sessionsStore({
    sessions: nextSessions,
    sessionGroups: getSortedSessionGroups(nextSessions, sessionsStore.sessionGroups),
  });
  updateRuntime(sessionId, {
    session: liveSession,
    load: 'loaded',
    options: { ...getRuntime(sessionId).options, ...options },
  });

  if (configError) {
    setMessages(sessionId, [{ ...userMessage, failed: true }]);
    updateRuntime(sessionId, { error: configError });
    onFailed?.();
  } else {
    recordOptimisticMessage(sessionId, userMessage.id);
    setMessages(sessionId, [userMessage]);
    startPromptOnSession(liveSession, userMessage, onFailed);
  }
  return liveSession;
};

/** Fork `session` up to and including the agent message `messageId` and list the new session; it loads when opened. */
export const forkSession = async (session: DeckSession, messageId: string): Promise<DeckSession | null> => {
  if (agentdeckStore.connection !== 'connected') {
    Toast.open('error', i18n.get('error.remoteNotConnected'));
    return null;
  }
  let forkedResult: { sessionId: string; title?: string; updatedAt?: string };
  try {
    forkedResult = await agentApi.forkSession({ ...session, messageId });
  } catch (error) {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('error.forkSessionFailed'));
    return null;
  }
  const forked: DeckSession = {
    agent: session.agent,
    sessionId: forkedResult.sessionId,
    cwd: session.cwd,
    title: forkedResult.title || (session.title && `${session.title} (fork)`),
    updatedAt: forkedResult.updatedAt || new Date().toISOString(),
  };
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
  const runtime = getRuntime(sessionId);
  if (
    (!text && !attachments.length) ||
    !session ||
    session.pendingCreation ||
    agentdeckStore.connection !== 'connected' ||
    runtime.load !== 'loaded' ||
    !runtime.subscribed ||
    isTurnRunning(sessionId)
  ) {
    onFailed?.();
    return false;
  }
  const messages = completeThought(getMessages(sessionId));
  const userMessage: TextMessage = { id: crypto.randomUUID(), role: 'user', text, attachments, voiceChat };
  recordOptimisticMessage(sessionId, userMessage.id);
  setMessages(sessionId, [...messages, userMessage]);
  startPromptOnSession(session, userMessage, onFailed);
  return true;
};

export const cancelTurn = (sessionId: string) => {
  const session = getSession(sessionId);
  if (!session || !isTurnRunning(sessionId)) return;
  settleUserInput(sessionId);
  if (session.pendingCreation) {
    creatingTokens.delete(sessionId);
    updateRuntime(sessionId, { creating: false });
    return;
  }
  cancelTurnPrompt(session).catch((error) => {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('error.cancelTaskFailed'));
    updateRuntime(sessionId, { running: false });
    finishSessionTree(sessionId);
  });
};

/** Called only when the daemon reports an unexpected ACP failure (`agent_session_ended`). */
export const endSession = (sessionId: string) => {
  clearSessionTransient(sessionId);
  settleUserInput(sessionId);
  finishSessionTree(sessionId);
  updateRuntime(sessionId, {
    load: 'idle',
    running: false,
    subscribed: false,
    epoch: undefined,
    lastSeq: undefined,
    error: i18n.get('error.remoteSessionEnded'),
  });
};
