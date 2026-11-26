import type {
  AgentApi,
  PanelContext,
  SessionConfigOption,
  SessionEvent,
  SessionEventNotification,
  SessionStateUpdate,
} from 'agentdeck/agent/api';
import {
  agentSessionKey,
  type SessionRecord,
  sessionTitleFromPrompt,
  upsertStoredSession,
} from '../../shared/agent-session-store';
import {
  completeThought,
  DRAFT_SESSION_KEY,
  type SessionRuntime,
  withAgentConfigOptions,
  withConfigValue,
} from './session-runtime';
import type { TurnController } from './turn-controller';
import type { Pane, PanelStore, PromptPayload } from './types';

type SessionControllerOptions = {
  state: PanelStore;
  runtime: SessionRuntime;
  turns: TurnController;
  api: AgentApi;
};

type SessionTarget = { agent: string; sessionId: string };
type OpenSessionOptions = { force?: boolean };
type BufferedSessionEvent = { epoch: string; event: SessionEvent };
type PendingOpen = { alive: boolean; events: BufferedSessionEvent[] };

export type SessionController = ReturnType<typeof createSessionController>;

// The host only adds browser instructions when its browser4agent sees this tab, i.e. same browser.
async function getPanelContext(): Promise<PanelContext> {
  const inspectedWindow = chrome.devtools?.inspectedWindow;
  if (inspectedWindow) {
    const url = await new Promise<string>((resolve) => inspectedWindow.eval<string>('location.href', resolve));
    return { surface: 'devtools', tabId: inspectedWindow.tabId, url };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { surface: 'side_panel', tabId: tab?.id, url: tab?.url };
}

export function createSessionController({ state, runtime, turns, api }: SessionControllerOptions) {
  // A cleared record makes a settling open inert after deletion/reconnect.
  const pendingOpens = new Map<string, PendingOpen>();

  const openNewSession = () => {
    if (state.loadingIds.includes(DRAFT_SESSION_KEY)) return;
    state({ newSessionOpen: true, error: '' });
  };

  const applyComposerConfig = async (
    target: SessionTarget,
    configOptions: SessionConfigOption[],
    composerConfigOptions: SessionConfigOption[],
  ) => {
    let current = configOptions;
    for (const selected of composerConfigOptions) {
      const option = current.find((item) => item.id === selected.id);
      const value = selected.currentValue;
      if (option?.type !== 'select' || typeof value !== 'string' || option.currentValue === value) continue;
      if (!option.options.some((item) => 'value' in item && item.value === value)) continue;
      const result = await api.setSessionConfigOption(target.agent, target.sessionId, option.id, value);
      current = Array.isArray(result.configOptions) ? result.configOptions : withConfigValue(current, option.id, value);
    }
    return current;
  };

  /** Turn the single local draft into an ACP session, then deliver its first prompt. */
  const startDraftTurn = async (sessionKey: string, payload: PromptPayload) => {
    const draft = runtime.record(sessionKey);
    const draftState = runtime.getPane(sessionKey);
    if (!draft?.draft || !draftState) return;
    let createdTarget: SessionTarget | null = null;
    const clientMessageId = turns.stage(sessionKey, payload);
    runtime.setLoading(sessionKey, true);
    try {
      const created = await api.createSession({
        agent: draft.agent,
        cwd: draft.cwd || '',
        panelContext: await getPanelContext(),
      });
      if (!created.sessionId) throw new Error('Missing session id');
      createdTarget = { agent: draft.agent, sessionId: created.sessionId };
      const liveSessionKey = agentSessionKey(draft.agent, created.sessionId);
      runtime.setSync(liveSessionKey, {
        epoch: created.epoch,
        lastSeq: created.seq ?? 0,
        subscribed: true,
      });
      const composerConfigOptions = runtime.getPane(sessionKey)?.configOptions ?? draftState.configOptions;
      const configOptions = await applyComposerConfig(
        createdTarget,
        created.configOptions || [],
        composerConfigOptions,
      );
      const now = new Date().toISOString();
      const session: SessionRecord = {
        key: liveSessionKey,
        agent: draft.agent,
        sessionId: created.sessionId,
        title: created.title || sessionTitleFromPrompt(payload.prompt),
        cwd: draft.cwd,
        createdAt: now,
        updatedAt: created.updatedAt || now,
      };
      const stagedPane = runtime.getPane(sessionKey) ?? draftState;
      const pane: Pane = {
        messages: stagedPane.messages,
        configOptions,
        cwd: draft.cwd || '',
        queue: stagedPane.queue,
      };
      const isCurrent = state.sessionKey === sessionKey;
      runtime.moveOptimisticIds(sessionKey, liveSessionKey);
      runtime.deletePane(sessionKey);
      runtime.setCachedPane(liveSessionKey, pane);
      state({ draftSession: null });
      runtime.setPending(sessionKey, false);
      runtime.setPending(liveSessionKey, true);
      if (isCurrent) {
        runtime.showPane(liveSessionKey, pane, { error: '' });
      }
      runtime.setLoading(sessionKey, false);
      const persistence = runtime.mutateStoredState((storedState) =>
        upsertStoredSession(withAgentConfigOptions(storedState, draft.agent, configOptions), session),
      );
      createdTarget = null;
      turns.run(liveSessionKey, payload, true, clientMessageId);
      await persistence;
    } catch (e) {
      if (createdTarget) {
        runtime.deletePane(agentSessionKey(createdTarget.agent, createdTarget.sessionId));
        api.closeSession(createdTarget.agent, createdTarget.sessionId).catch(() => {});
      }
      runtime.setError(sessionKey, e.message);
      runtime.setPending(sessionKey, false);
      runtime.setLoading(sessionKey, false);
    }
  };

  /** Replace the existing empty draft, if any, with the newly selected settings. */
  const confirmNewSession = ({ agent, cwd }: { agent: string; cwd: string }) => {
    runtime.snapshotCurrent();
    const now = new Date().toISOString();
    const draftSession: SessionRecord = {
      key: DRAFT_SESSION_KEY,
      agent,
      title: '',
      cwd,
      createdAt: now,
      updatedAt: now,
      draft: true,
    };
    const configOptions = state.defaults.configOptionsByAgent[agent] || [];
    const pane: Pane = { messages: [], configOptions, cwd, queue: [] };
    runtime.setCachedPane(DRAFT_SESSION_KEY, pane);
    state({
      draftSession,
      sessionKey: DRAFT_SESSION_KEY,
      ...pane,
      newSessionOpen: false,
      error: '',
    });
    runtime.persistAgentDefault(agent);
  };

  const applyLiveEvent = (sessionKey: string, epoch: string, event: SessionEvent) => {
    runtime.applyEvent(sessionKey, event);
    runtime.setSync(sessionKey, { epoch, lastSeq: event.seq });
    if (event.event === 'turn_started') {
      runtime.clearError(sessionKey);
      runtime.setPending(sessionKey, true);
    } else if (event.event === 'turn_ended') {
      turns.handleTurnEnded(sessionKey, {
        error: event.error,
        cancelled: event.stopReason === 'cancelled',
      });
    }
  };

  const openSession = async (sessionKey: string, { force = false }: OpenSessionOptions = {}) => {
    const isCurrent = sessionKey === state.sessionKey;
    if (!force && isCurrent && (runtime.isSubscribed(sessionKey) || pendingOpens.has(sessionKey))) return;
    const previousLoad = pendingOpens.get(sessionKey);
    if (previousLoad && !force) return;
    if (previousLoad) {
      previousLoad.alive = false;
      pendingOpens.delete(sessionKey);
    }
    if (!isCurrent) runtime.snapshotCurrent();
    const selected = runtime.record(sessionKey);
    if (!selected) return;
    state({ error: '' });

    const cached = runtime.getCachedPane(sessionKey);
    if (!force && cached && runtime.isSubscribed(sessionKey)) {
      runtime.showPane(sessionKey, cached);
      return;
    }

    const target = runtime.target(sessionKey);
    if (!target) return;
    const cwd = selected.cwd || '';
    const prevSync = runtime.getSync(sessionKey);
    const hasLocalState = Boolean(cached || (isCurrent && prevSync?.epoch));

    runtime.clearError(sessionKey);
    if (cached && !isCurrent) {
      runtime.showPane(sessionKey, cached);
    } else if (!hasLocalState) {
      state({
        sessionKey,
        cwd,
        messages: [],
        configOptions: [],
        queue: [],
      });
      runtime.setLoading(sessionKey, true);
    }

    const record: PendingOpen = { alive: true, events: [] };
    pendingOpens.set(sessionKey, record);
    const replayEvents: SessionEvent[] = [];

    try {
      const opened = await api.openSession({
        ...target,
        cwd,
        sinceEpoch: prevSync?.epoch,
        sinceSeq: prevSync?.epoch ? prevSync.lastSeq : undefined,
        onEvent: (event) => {
          if (!record.alive) return;
          replayEvents.push(event);
        },
        panelContext: await getPanelContext(),
      });
      if (!record.alive) return;

      const fullReplay = opened.fullReplay !== false;
      const epoch = opened.epoch ?? prevSync?.epoch;
      const prevSeq = fullReplay ? 0 : (prevSync?.lastSeq ?? 0);
      if (fullReplay) {
        runtime.clearOptimisticIds(sessionKey);
        runtime.setPane(sessionKey, { messages: [] });
        runtime.setSync(sessionKey, { epoch, lastSeq: 0 });
      }
      for (const event of replayEvents) {
        if (!fullReplay && typeof event.seq === 'number' && event.seq <= prevSeq) continue;
        runtime.applyEvent(sessionKey, event);
      }

      const defaults = state.defaults.configOptionsByAgent[selected.agent];
      let loadedOptions = opened.configOptions || [];
      // Re-apply saved agent defaults only when the daemon freshly loaded the session from the agent.
      if (opened.freshLoad && defaults?.length) {
        try {
          loadedOptions = await applyComposerConfig(target, loadedOptions, defaults);
        } catch (e) {
          runtime.setError(sessionKey, e.message);
        }
        if (!record.alive) return;
      } else if (!defaults?.length && loadedOptions.length) {
        // No selection saved for this agent yet: use the first loaded session as defaults for new sessions.
        await runtime.persistConfigOptions(selected.agent, loadedOptions);
      }

      const running = Boolean(opened.running);
      if (running) {
        runtime.setPending(sessionKey, true);
      } else {
        runtime.finishThought(sessionKey);
        runtime.setPending(sessionKey, false);
        turns.handleTurnEnded(sessionKey, { cancelled: true });
      }
      turns.syncSessionPermissions(sessionKey, opened.userInputs || []);

      const { title, updatedAt } = opened;
      if (title || updatedAt) {
        runtime.patchRecord(sessionKey, {
          ...(title && { title }),
          ...(updatedAt && { updatedAt }),
        });
      }

      if (state.sessionKey === sessionKey) {
        const pane: Pane = {
          messages: running ? state.messages : completeThought(state.messages),
          configOptions: loadedOptions,
          cwd: state.cwd,
          queue: state.queue,
        };
        runtime.setCachedPane(sessionKey, pane);
        state({ configOptions: pane.configOptions });
      } else {
        const pane = runtime.getCachedPane(sessionKey);
        if (pane) {
          runtime.setCachedPane(sessionKey, {
            ...pane,
            messages: running ? pane.messages : completeThought(pane.messages),
            configOptions: loadedOptions,
          });
        }
      }

      const seq = Math.max(opened.seq ?? 0, runtime.getSync(sessionKey)?.lastSeq ?? 0);
      runtime.setSync(sessionKey, { epoch, lastSeq: seq, subscribed: true });

      const buffered = record.events;
      record.events = [];
      for (const item of buffered) {
        if (epoch && item.epoch !== epoch) continue;
        if (item.event.seq <= (runtime.getSync(sessionKey)?.lastSeq ?? 0)) continue;
        applyLiveEvent(sessionKey, item.epoch, item.event);
      }
    } catch (e) {
      if (!record.alive) return;
      runtime.setError(sessionKey, e.message);
      if (!hasLocalState) runtime.deletePane(sessionKey);
    } finally {
      if (pendingOpens.get(sessionKey) === record) {
        pendingOpens.delete(sessionKey);
        runtime.setLoading(sessionKey, false);
      }
    }
  };

  const handleSessionEvent = ({ agent, sessionId, epoch, event }: SessionEventNotification) => {
    const sessionKey = agentSessionKey(agent, sessionId);
    const pending = pendingOpens.get(sessionKey);
    if (pending) {
      pending.events.push({ epoch, event });
      return;
    }
    const sync = runtime.getSync(sessionKey);
    if (!sync?.subscribed) return;
    if (sync.epoch && sync.epoch !== epoch) {
      openSession(sessionKey, { force: true });
      return;
    }
    if (event.seq <= sync.lastSeq) return;
    if (sync.epoch === epoch && event.seq > sync.lastSeq + 1) {
      openSession(sessionKey, { force: true });
      return;
    }
    applyLiveEvent(sessionKey, epoch, event);
  };

  const handleSessionState = (update: SessionStateUpdate) => {
    const sessionKey = agentSessionKey(update.agent, update.sessionId);
    if (update.title || update.updatedAt) {
      runtime.patchRecord(sessionKey, {
        ...(update.title && { title: update.title }),
        ...(update.updatedAt && { updatedAt: update.updatedAt }),
      });
    }
    if (!runtime.record(sessionKey) || runtime.isSubscribed(sessionKey)) return;
    if (update.running) {
      runtime.clearError(sessionKey);
      runtime.setPending(sessionKey, true);
    } else if (state.pendingIds.includes(sessionKey) || update.error) {
      turns.handleTurnEnded(sessionKey, {
        error: update.error,
        cancelled: !update.completed && !update.error,
      });
    }
  };

  const reconcileActiveSessions = async () => {
    if (!api.listActiveSessions) return;
    try {
      const { sessions = [], userInputs = [] } = await api.listActiveSessions();
      const activeKeys = new Set(sessions.map((item) => agentSessionKey(item.agent, item.sessionId)));
      for (const sessionKey of [...state.pendingIds]) {
        if (runtime.record(sessionKey)?.draft || pendingOpens.has(sessionKey) || runtime.isSubscribed(sessionKey)) {
          continue;
        }
        if (!activeKeys.has(sessionKey)) {
          turns.handleTurnEnded(sessionKey, { cancelled: true });
        }
      }
      for (const sessionKey of activeKeys) {
        if (!runtime.record(sessionKey) || pendingOpens.has(sessionKey) || runtime.isSubscribed(sessionKey)) continue;
        runtime.setPending(sessionKey, true);
      }
      const activePermissionIds = new Map<string, string>();
      for (const input of userInputs) {
        if (input.method !== 'agent_permission_request') continue;
        const sessionKey = agentSessionKey(input.params.agent, input.params.sessionId);
        if (!runtime.record(sessionKey)) continue;
        activePermissionIds.set(sessionKey, input.params.requestId);
        if (!pendingOpens.has(sessionKey) && !runtime.isSubscribed(sessionKey)) {
          turns.handleUserInput(input);
        }
      }
      for (const [sessionKey, permission] of Object.entries(state.permissions)) {
        if (pendingOpens.has(sessionKey) || runtime.isSubscribed(sessionKey)) continue;
        if (activePermissionIds.get(sessionKey) !== permission.requestId) {
          turns.syncSessionPermissions(sessionKey, []);
        }
      }
    } catch {
      // Transient disconnect during reconnect; the next connected cycle reconciles again.
    }
  };

  const resyncCurrentSession = () => {
    const sessionKey = state.sessionKey;
    const reopen = sessionKey && !runtime.record(sessionKey)?.draft ? openSession(sessionKey, { force: true }) : null;
    const reconcile = reconcileActiveSessions();
    return Promise.all([reopen, reconcile]);
  };

  const markAllUnsubscribed = () => {
    runtime.markAllUnsubscribed();
  };

  const deleteSession = async (sessionKey: string) => {
    if (state.deleting) return;
    let selected = runtime.record(sessionKey);
    if (!selected) return;
    const loadRecord = pendingOpens.get(sessionKey);
    if (loadRecord) {
      loadRecord.alive = false;
      pendingOpens.delete(sessionKey);
      runtime.setLoading(sessionKey, false);
    }
    if (state.pendingIds.includes(sessionKey)) await turns.abort(sessionKey);
    selected = runtime.record(sessionKey) || selected;
    const isDraft = selected.draft === true && state.draftSession?.key === sessionKey;
    const isCurrent = state.sessionKey === sessionKey;
    const sessionList = runtime.list();
    const sessionIndex = sessionList.findIndex((session) => session.key === sessionKey);
    const fallbackKey =
      isCurrent && sessionIndex >= 0
        ? (sessionList[sessionIndex - 1]?.key ?? sessionList[sessionIndex + 1]?.key)
        : null;
    const previousSessions = state.sessions;
    const previousDraft = state.draftSession;
    state({ deleting: sessionKey });
    try {
      const target = runtime.target(sessionKey);
      if (isDraft || !target) {
        state({ draftSession: null });
      } else {
        await api.deleteSession(target.agent, target.sessionId).catch(() => {});
        await runtime.removeRecord(sessionKey);
      }
      turns.clearSession(sessionKey);
      runtime.deletePane(sessionKey);
      runtime.clearError(sessionKey);
      if (isCurrent) {
        if (fallbackKey) {
          await openSession(fallbackKey);
        } else {
          state({
            sessionKey: null,
            messages: [],
            configOptions: [],
            queue: [],
            cwd: '',
            error: '',
          });
        }
      }
    } catch (e) {
      state({ sessions: previousSessions, draftSession: previousDraft, error: e.message });
      return;
    } finally {
      state({ deleting: null });
    }
  };

  const changeConfig = async (configId: string, value: string) => {
    const sessionKey = state.sessionKey;
    if (!sessionKey) return;
    const session = runtime.record(sessionKey);
    if (!session) return;
    if (!session.draft && !runtime.isSubscribed(sessionKey)) return;
    const previous = runtime.getPane(sessionKey)?.configOptions ?? [];
    runtime.clearError(sessionKey);
    const staged = withConfigValue(previous, configId, value);
    runtime.setPane(sessionKey, { configOptions: staged });
    if (session.draft) {
      await runtime.persistConfigOptions(session.agent, staged);
      return;
    }
    const target = runtime.target(sessionKey);
    if (!target) return;
    try {
      const { configOptions } = await api.setSessionConfigOption(target.agent, target.sessionId, configId, value);
      const applied = Array.isArray(configOptions) ? configOptions : staged;
      runtime.setPane(sessionKey, { configOptions: applied });
      await runtime.persistConfigOptions(target.agent, applied);
    } catch (e) {
      runtime.setError(sessionKey, e.message);
      if (runtime.getPane(sessionKey)?.configOptions === staged) {
        runtime.setPane(sessionKey, { configOptions: previous });
      }
    }
  };

  const handleSessionEnded = ({ agent, sessionId }: SessionTarget) => {
    const sessionKey = agentSessionKey(agent, sessionId);
    const record = pendingOpens.get(sessionKey);
    if (record) {
      record.alive = false;
      pendingOpens.delete(sessionKey);
      runtime.setLoading(sessionKey, false);
    }
    turns.clearSession(sessionKey);
    runtime.deletePane(sessionKey);
    if (sessionKey === state.sessionKey) {
      state({
        sessionKey: null,
        messages: [],
        configOptions: [],
        queue: [],
        cwd: '',
      });
    }
  };

  return {
    openNewSession,
    startDraftTurn,
    confirmNewSession,
    openSession,
    handleSessionEvent,
    handleSessionState,
    resyncCurrentSession,
    markAllUnsubscribed,
    deleteSession,
    changeConfig,
    handleSessionEnded,
  };
}
