import type { AgentApi, PanelContext, SessionConfigOption } from 'agentdeck/agent/api';
import {
  agentSessionKey,
  type SessionRecord,
  sessionTitleFromPrompt,
  upsertStoredSession,
} from '../../shared/agent-session-store';
import { t } from '../../shared/i18n';
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
  // A cleared record makes a settling load inert after deletion/reconnect.
  const pendingLoads = new Map<string, { alive: boolean }>();

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
    turns.stage(sessionKey, payload);
    runtime.setLoading(sessionKey, true);
    try {
      const created = await api.createSession({
        agent: draft.agent,
        cwd: draft.cwd || '',
        panelContext: await getPanelContext(),
      });
      if (!created.sessionId) throw new Error('Missing session id');
      createdTarget = { agent: draft.agent, sessionId: created.sessionId };
      const composerConfigOptions = runtime.getPane(sessionKey)?.configOptions ?? draftState.configOptions;
      const configOptions = await applyComposerConfig(
        createdTarget,
        created.configOptions || [],
        composerConfigOptions,
      );
      const liveSessionKey = agentSessionKey(draft.agent, created.sessionId);
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
      turns.run(liveSessionKey, payload, true);
      await persistence;
    } catch (e) {
      if (createdTarget) api.closeSession(createdTarget.agent, createdTarget.sessionId).catch(() => {});
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

  const openSession = async (sessionKey: string) => {
    const isCurrent = sessionKey === state.sessionKey;
    if (isCurrent && (runtime.hasCachedPane(sessionKey) || pendingLoads.has(sessionKey))) return;
    if (!isCurrent) runtime.snapshotCurrent();
    const selected = runtime.record(sessionKey);
    if (!selected) return;
    state({ error: '' });

    const cached = runtime.getCachedPane(sessionKey);
    if (cached) {
      runtime.showPane(sessionKey, cached);
      return;
    }

    const target = runtime.target(sessionKey);
    if (!target) return;
    const cwd = selected.cwd || '';

    runtime.clearError(sessionKey);
    state({
      sessionKey,
      cwd,
      messages: [],
      configOptions: [],
      queue: [],
    });
    runtime.setLoading(sessionKey, true);
    const record = { alive: true };
    pendingLoads.set(sessionKey, record);
    try {
      await api.closeSession(target.agent, target.sessionId).catch(() => {});
      const { configOptions, title, updatedAt } = await api.loadSession({
        ...target,
        cwd,
        onEvent: (event) => runtime.applyEvent(sessionKey, event),
        panelContext: await getPanelContext(),
      });
      if (!record.alive) return;
      const defaults = state.defaults.configOptionsByAgent[selected.agent];
      let loadedOptions = configOptions || [];
      // Agents reset mode / model on load; re-apply the agent's saved selection
      if (defaults?.length) {
        try {
          loadedOptions = await applyComposerConfig(target, loadedOptions, defaults);
        } catch (e) {
          runtime.setError(sessionKey, e.message);
        }
        if (!record.alive) return;
      } else if (loadedOptions.length) {
        // No selection saved for this agent yet: use the first loaded session as defaults for new sessions
        await runtime.persistConfigOptions(selected.agent, loadedOptions);
      }
      runtime.finishThought(sessionKey);
      if (title || updatedAt) {
        runtime.patchRecord(sessionKey, {
          ...(title && { title }),
          ...(updatedAt && { updatedAt }),
        });
      }
      if (state.sessionKey === sessionKey) {
        const pane: Pane = {
          messages: state.messages,
          configOptions: loadedOptions,
          cwd: state.cwd,
          queue: [],
        };
        runtime.setCachedPane(sessionKey, pane);
        state({ configOptions: pane.configOptions });
      } else {
        const pane = runtime.getCachedPane(sessionKey);
        if (pane)
          runtime.setCachedPane(sessionKey, {
            ...pane,
            messages: completeThought(pane.messages),
            configOptions: loadedOptions,
          });
      }
    } catch (e) {
      if (!record.alive) return;
      runtime.setError(sessionKey, e.message);
      runtime.deletePane(sessionKey);
    } finally {
      if (pendingLoads.get(sessionKey) === record) {
        pendingLoads.delete(sessionKey);
        runtime.setLoading(sessionKey, false);
      }
    }
  };

  const deleteSession = async (sessionKey: string) => {
    if (state.deleting) return;
    let selected = runtime.record(sessionKey);
    if (!selected) return;
    const loadRecord = pendingLoads.get(sessionKey);
    if (loadRecord) {
      loadRecord.alive = false;
      pendingLoads.delete(sessionKey);
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
        if (isCurrent || loadRecord || runtime.hasCachedPane(sessionKey)) {
          await api.closeSession(target.agent, target.sessionId).catch(() => {});
        }
        await api.deleteSession(target.agent, target.sessionId).catch(() => {});
        await runtime.removeRecord(sessionKey);
      }
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
    const record = pendingLoads.get(sessionKey);
    if (record) {
      record.alive = false;
      pendingLoads.delete(sessionKey);
      runtime.setLoading(sessionKey, false);
    }
    runtime.deletePane(sessionKey);
    turns.decidePermission(sessionKey, null);
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

  const handleHostReconnect = () => {
    turns.declineAllPermissions();
    for (const record of pendingLoads.values()) record.alive = false;
    pendingLoads.clear();
    const draftLoading = runtime.resetPanesForReconnect();
    const currentSessionKey = state.sessionKey;
    const currentIsDraft = state.draftSession?.key === currentSessionKey;
    turns.clearCanceledSessions();
    state({
      loadingIds: draftLoading ? [DRAFT_SESSION_KEY] : [],
      pendingIds: [],
      permissions: {},
      sessionErrors: {},
      ...(!currentIsDraft &&
        currentSessionKey && {
          sessionKey: null,
          messages: [],
          configOptions: [],
          queue: [],
          cwd: '',
          error: t('devtoolsPanelHostReconnected'),
        }),
    });
  };

  return {
    openNewSession,
    startDraftTurn,
    confirmNewSession,
    openSession,
    deleteSession,
    changeConfig,
    handleSessionEnded,
    handleHostReconnect,
  };
}
