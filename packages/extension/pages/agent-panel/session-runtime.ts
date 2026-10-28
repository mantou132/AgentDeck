import type { SessionConfigOption, SessionEvent } from 'agentdeck/agent/api';
import { imageAttachment } from 'agentdeck/attachment/message';
import {
  type AgentPanelState,
  removeStoredSession,
  type SessionRecord,
  updateAgentPanelState,
  upsertStoredSession,
} from '../../shared/agent-session-store';
import { t } from '../../shared/i18n';
import type { AcpUpdate, Pane, PanelMessage, PanelStore } from './types';

export const DRAFT_SESSION_KEY = 'draft';
const CLAUDE_INTERRUPTED_USER_MESSAGE = '[Request interrupted by user]';

type TextMessage = Extract<PanelMessage, { role: string }>;

type ChunkContent = { type?: string; text?: string; data?: string; mimeType?: string };

type SessionEventReduction = {
  pane?: Partial<Pane>;
  session?: Pick<SessionRecord, 'title' | 'updatedAt'>;
} | null;

/** Keep the `mode` config option in sync with a `current_mode_update`. */
export function withCurrentMode(configOptions: SessionConfigOption[], currentModeId: string) {
  return withConfigValue(configOptions, 'mode', currentModeId);
}

/** Keep one config option in sync with a locally staged change. */
export function withConfigValue(configOptions: SessionConfigOption[], configId: string, value: string) {
  return configOptions.map((option) =>
    option.id === configId ? ({ ...option, currentValue: value } as SessionConfigOption) : option,
  );
}

export function withAgentConfigOptions(
  state: AgentPanelState,
  agent: string,
  configOptions: SessionConfigOption[],
): AgentPanelState {
  return {
    ...state,
    defaults: {
      ...state.defaults,
      configOptionsByAgent: {
        ...state.defaults.configOptionsByAgent,
        [agent]: configOptions,
      },
    },
  };
}

/** Append a streaming chunk to the last matching message, else start a new one. */
function appendChunk<T extends PanelMessage>(
  messages: PanelMessage[],
  match: (message?: PanelMessage) => message is T,
  make: (last?: T) => PanelMessage,
) {
  const next = messages.slice();
  const last = next.at(-1);
  if (match(last)) {
    next[next.length - 1] = make(last);
  } else {
    next.push(make());
  }
  return next;
}

export function completeThought(messages: PanelMessage[]) {
  const last = messages.at(-1);
  if (last?.type !== 'thought' || !last.pending) return messages;
  const next = messages.slice();
  next[next.length - 1] = { ...last, pending: false };
  return next;
}

/** Convert one streamed ACP event into local pane and session-index patches. */
export function reduceSessionEvent(
  state: Partial<Pane> | undefined,
  event: SessionEvent,
  { agent }: { agent?: string } = {},
): SessionEventReduction {
  const messages = state?.messages ?? [];
  if (event.event !== 'session_update') {
    if (event.event !== 'stop') return null;
    const completed = completeThought(messages);
    return completed === messages ? null : { pane: { messages: completed } };
  }

  const update = event.update as AcpUpdate;
  const content = update.content as ChunkContent | undefined;
  const text = content?.text ?? '';
  const thoughtChunk = update.sessionUpdate === 'agent_thought_chunk' && content?.type === 'text';
  const currentMessages = thoughtChunk ? messages : completeThought(messages);
  const role =
    update.sessionUpdate === 'agent_message_chunk'
      ? 'agent'
      : update.sessionUpdate === 'user_message_chunk'
        ? 'user'
        : null;
  const isRoleMessage = (message?: PanelMessage): message is TextMessage =>
    message?.type === undefined && message?.role === role;

  if (role && content?.type === 'text') {
    if (agent === 'claude-acp' && role === 'user' && text.trim() === CLAUDE_INTERRUPTED_USER_MESSAGE) {
      return currentMessages === messages ? null : { pane: { messages: currentMessages } };
    }
    return {
      pane: {
        messages: appendChunk(currentMessages, isRoleMessage, (last) =>
          last ? { ...last, text: last.text + text } : { role, text },
        ),
      },
    };
  }

  if (role && content?.type === 'image' && content.data) {
    const attachment = imageAttachment(
      content.data,
      content.mimeType || 'image/png',
      t('devtoolsPanelImageAttachment'),
    );
    return {
      pane: {
        messages: appendChunk(currentMessages, isRoleMessage, (last) =>
          last
            ? { ...last, attachments: [...(last.attachments || []), attachment] }
            : { role, text: '', attachments: [attachment] },
        ),
      },
    };
  }

  if (thoughtChunk) {
    return {
      pane: {
        messages: appendChunk(
          currentMessages,
          (last) => last?.type === 'thought',
          (last) =>
            last ? { ...last, text: last.text + text, pending: true } : { type: 'thought', text, pending: true },
        ),
      },
    };
  }

  if (update.sessionUpdate === 'tool_call') {
    return { pane: { messages: [...currentMessages, { type: 'tool', data: update }] } };
  }

  if (update.sessionUpdate === 'tool_call_update') {
    const next = currentMessages.slice();
    const index = next.findLastIndex(
      (message) => message.type === 'tool' && message.data.toolCallId === update.toolCallId,
    );
    const tool = next[index];
    if (tool?.type === 'tool') {
      next[index] = { ...tool, data: { ...tool.data, ...update, sessionUpdate: 'tool_call' } };
    } else {
      next.push({ type: 'tool', data: update });
    }
    next.push({ type: 'event', data: update });
    return { pane: { messages: next } };
  }

  if (update.sessionUpdate === 'current_mode_update') {
    return { pane: { configOptions: withCurrentMode(state?.configOptions ?? [], update.currentModeId as string) } };
  }

  if (update.sessionUpdate === 'config_option_update') {
    return {
      pane: {
        configOptions: Array.isArray(update.configOptions) ? (update.configOptions as SessionConfigOption[]) : [],
      },
    };
  }

  if (update.sessionUpdate === 'session_info_update') {
    const session: Pick<SessionRecord, 'title' | 'updatedAt'> = {};
    if (typeof update.title === 'string' && update.title) session.title = update.title;
    if (typeof update.updatedAt === 'string' && update.updatedAt) session.updatedAt = update.updatedAt;
    return Object.keys(session).length ? { session } : null;
  }

  return { pane: { messages: [...currentMessages, { type: 'event', data: update }] } };
}

export type SessionRuntime = ReturnType<typeof createSessionRuntime>;

/** State access shared by session and turn controllers. It owns the pane cache
 * but not any ACP request lifecycle. */
export function createSessionRuntime(state: PanelStore) {
  const paneCache = new Map<string, Pane>();

  const record = (sessionKey: string | null) =>
    state.draftSession?.key === sessionKey
      ? state.draftSession
      : state.sessions.find((session) => session.key === sessionKey);

  const list = () => (state.draftSession ? [state.draftSession, ...state.sessions] : state.sessions);

  const target = (sessionKey: string) => {
    const session = record(sessionKey);
    return session?.sessionId ? { agent: session.agent, sessionId: session.sessionId } : null;
  };

  const getPane = (sessionKey: string): Pane | undefined =>
    sessionKey === state.sessionKey ? state : paneCache.get(sessionKey);

  const setPane = (sessionKey: string, patch: Partial<Pane>) => {
    const cached = paneCache.get(sessionKey);
    if (sessionKey === state.sessionKey) {
      state(patch);
    } else if (cached) {
      paneCache.set(sessionKey, { ...cached, ...patch });
    }
  };

  const showPane = (sessionKey: string, { messages, configOptions, queue, cwd }: Pane, patch?: { error: string }) => {
    state({ sessionKey, messages, configOptions, queue, cwd, ...patch });
  };

  const snapshotCurrent = () => {
    if (!state.sessionKey) return;
    if (!paneCache.has(state.sessionKey) && !state.loadingIds.includes(state.sessionKey)) return;
    paneCache.set(state.sessionKey, {
      messages: completeThought(state.messages),
      configOptions: state.configOptions,
      cwd: state.cwd,
      queue: state.queue,
    });
  };

  const setSessionFlag = (field: 'loadingIds' | 'pendingIds', sessionKey: string, enabled: boolean) => {
    const ids = state[field].filter((key) => key !== sessionKey);
    if (enabled) ids.push(sessionKey);
    state({ [field]: ids });
  };

  const setError = (sessionKey: string | null, message: string) => {
    if (!sessionKey) {
      state({ error: message });
      return;
    }
    state({ sessionErrors: { ...state.sessionErrors, [sessionKey]: message } });
  };

  const clearError = (sessionKey: string) => {
    if (!state.sessionErrors[sessionKey]) return;
    const { [sessionKey]: _, ...sessionErrors } = state.sessionErrors;
    state({ sessionErrors });
  };

  /** Apply locally at once, then again on the freshest stored value. */
  const mutateStoredState = async (update: (state: AgentPanelState) => AgentPanelState) => {
    const local = update({ relayId: state.relayId, sessions: state.sessions, defaults: state.defaults });
    state({ sessions: local.sessions, defaults: local.defaults });
    try {
      const stored = await updateAgentPanelState(update);
      state({ sessions: stored.sessions, defaults: stored.defaults });
    } catch (e) {
      state({ error: e.message });
    }
  };

  const patchRecord = async (sessionKey: string, patch: Partial<SessionRecord>) => {
    if (!state.sessions.some((session) => session.key === sessionKey)) return;
    await mutateStoredState((storedState) => {
      const stored = storedState.sessions.find((session) => session.key === sessionKey);
      return stored ? upsertStoredSession(storedState, { ...stored, ...patch }) : storedState;
    });
  };

  const finishThought = (sessionKey: string) => {
    const pane = getPane(sessionKey);
    const messages = completeThought(pane?.messages ?? []);
    if (messages !== pane?.messages) setPane(sessionKey, { messages });
  };

  const applyEvent = (sessionKey: string, event: SessionEvent) => {
    const result = reduceSessionEvent(getPane(sessionKey), event, { agent: record(sessionKey)?.agent });
    if (result?.pane) setPane(sessionKey, result.pane);
    if (result?.session) patchRecord(sessionKey, result.session);
  };

  const resetPanesForReconnect = () => {
    const draftPane = state.draftSession && paneCache.get(DRAFT_SESSION_KEY);
    const draftLoading = Boolean(draftPane && state.loadingIds.includes(DRAFT_SESSION_KEY));
    paneCache.clear();
    if (draftPane) paneCache.set(DRAFT_SESSION_KEY, draftPane);
    return draftLoading;
  };

  return {
    record,
    list,
    target,
    getPane,
    setPane,
    showPane,
    snapshotCurrent,
    hasCachedPane: (sessionKey: string) => paneCache.has(sessionKey),
    getCachedPane: (sessionKey: string) => paneCache.get(sessionKey),
    setCachedPane: (sessionKey: string, pane: Pane) => paneCache.set(sessionKey, pane),
    deletePane: (sessionKey: string) => paneCache.delete(sessionKey),
    resetPanesForReconnect,
    setLoading: (sessionKey: string, loading: boolean) => setSessionFlag('loadingIds', sessionKey, loading),
    setPending: (sessionKey: string, pending: boolean) => setSessionFlag('pendingIds', sessionKey, pending),
    setError,
    clearError,
    mutateStoredState,
    patchRecord,
    removeRecord: (sessionKey: string) =>
      mutateStoredState((storedState) => removeStoredSession(storedState, sessionKey)),
    persistAgentDefault: (agent: string) =>
      mutateStoredState((storedState) => ({
        ...storedState,
        defaults: { ...storedState.defaults, agent },
      })),
    persistConfigOptions: (agent: string, configOptions: SessionConfigOption[]) =>
      mutateStoredState((storedState) => withAgentConfigOptions(storedState, agent, configOptions)),
    finishThought,
    applyEvent,
  };
}
