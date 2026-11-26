import type { AgentApi, UserInput, UserInputResolvedNotification } from 'agentdeck/agent/api';
import { toPromptAttachment } from 'agentdeck/attachment/prompt';
import { agentSessionKey, sessionTitleFromPrompt } from '../../shared/agent-session-store';
import type { SessionRuntime } from './session-runtime';
import type { PanelStore, PromptPayload, QueueItem } from './types';

type TurnControllerOptions = {
  state: PanelStore;
  runtime: SessionRuntime;
  api: AgentApi;
  scrollToLatest: () => void;
  startDraftTurn: (sessionKey: string, payload: PromptPayload) => Promise<void>;
};

type TurnEndInfo = {
  error?: string;
  cancelled?: boolean;
};

export type TurnController = ReturnType<typeof createTurnController>;

export function createTurnController({ state, runtime, api, scrollToLatest, startDraftTurn }: TurnControllerOptions) {
  const abortWaiters = new Map<string, Set<() => void>>();
  const canceledSessions = new Set<string>();

  const resolveTurnWaiters = (sessionKey: string) => {
    const waiters = abortWaiters.get(sessionKey);
    if (!waiters) return;
    abortWaiters.delete(sessionKey);
    for (const resolve of waiters) resolve();
  };

  const waitForTurnEnd = (sessionKey: string) => {
    if (!state.pendingIds.includes(sessionKey)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let waiters = abortWaiters.get(sessionKey);
      if (!waiters) {
        waiters = new Set();
        abortWaiters.set(sessionKey, waiters);
      }
      waiters.add(resolve);
    });
  };

  const clearLocalPermission = (sessionKey: string) => {
    if (!state.permissions[sessionKey]) return;
    const { [sessionKey]: _, ...permissions } = state.permissions;
    state({ permissions });
  };

  /** Show a permission request of the host (a notification); keyed by session so
   * requests survive switching and are answered when their session shows. The panel
   * has no question card, so form elicitations on subscribed panel sessions are
   * skipped (declined) at once without touching other devices' sessions. */
  const handleUserInput = (input: UserInput) => {
    const { params } = input;
    const sessionKey = agentSessionKey(params.agent, params.sessionId);
    if (input.method === 'agent_elicitation_request') {
      if (runtime.isSubscribed(sessionKey)) {
        api.respondUserInput(params, { action: 'decline' }).catch(console.error);
      }
      return;
    }
    if (!runtime.record(sessionKey)) return;
    // The host waits for one request per session; a newer one replaces the card.
    state({ permissions: { ...state.permissions, [sessionKey]: params } });
  };

  /** Dismiss a permission card when answered on another device or cancelled by the host. */
  const handleUserInputResolved = ({ agent, sessionId, requestId }: UserInputResolvedNotification) => {
    const sessionKey = agentSessionKey(agent, sessionId);
    if (state.permissions[sessionKey]?.requestId === requestId) {
      clearLocalPermission(sessionKey);
    }
  };

  /** Reconcile a session's permission card with the authoritative list from `openSession`. */
  const syncSessionPermissions = (sessionKey: string, userInputs: UserInput[]) => {
    const permission = userInputs.find((input) => input.method === 'agent_permission_request');
    if (permission) {
      state({ permissions: { ...state.permissions, [sessionKey]: permission.params } });
    } else {
      clearLocalPermission(sessionKey);
    }
  };

  /** Answer the permission of one session through the host; `null` cancels the tool call. */
  const decidePermission = (sessionKey: string | null, optionId: string | null) => {
    const request = sessionKey && state.permissions[sessionKey];
    if (!request) return;
    clearLocalPermission(sessionKey);
    api.respondUserInput(request, optionId ? { optionId } : {}).catch(console.error);
  };

  /** Show a submitted prompt immediately, before the host starts answering. */
  const stage = (sessionKey: string, { prompt, attachments }: PromptPayload, clientMessageId = crypto.randomUUID()) => {
    if (sessionKey === state.sessionKey) scrollToLatest();
    runtime.clearError(sessionKey);
    runtime.setPending(sessionKey, true);
    runtime.addOptimisticId(sessionKey, clientMessageId);
    runtime.setPane(sessionKey, {
      messages: [...(runtime.getPane(sessionKey)?.messages ?? []), { role: 'user', text: prompt, attachments }],
    });
    const current = runtime.record(sessionKey);
    const title = current?.title ? '' : sessionTitleFromPrompt(prompt);
    runtime.patchRecord(sessionKey, {
      ...(title && { title }),
      updatedAt: new Date().toISOString(),
    });
    return clientMessageId;
  };

  /** Settle a turn when the host reports `turn_ended` or `session_state(running: false)`. */
  const handleTurnEnded = (sessionKey: string, { error, cancelled }: TurnEndInfo = {}) => {
    const wasPending = state.pendingIds.includes(sessionKey);
    runtime.finishThought(sessionKey);
    runtime.setPending(sessionKey, false);
    clearLocalPermission(sessionKey);
    resolveTurnWaiters(sessionKey);
    if (error) {
      canceledSessions.delete(sessionKey);
      runtime.setError(sessionKey, error);
      return;
    }
    const wasCanceled = canceledSessions.delete(sessionKey) || Boolean(cancelled);
    if (wasPending && !wasCanceled) drainQueue(sessionKey);
  };

  /** Start one turn on the daemon; streaming events arrive via `agent_session_event`. */
  const run = async (
    sessionKey: string,
    { prompt, attachments }: PromptPayload,
    staged = false,
    stagedClientMessageId?: string,
  ) => {
    const target = runtime.target(sessionKey);
    if (!target) return;
    let clientMessageId: string;
    if (staged) {
      if (sessionKey === state.sessionKey) scrollToLatest();
      runtime.clearError(sessionKey);
      runtime.setPending(sessionKey, true);
      clientMessageId = stagedClientMessageId ?? crypto.randomUUID();
      runtime.addOptimisticId(sessionKey, clientMessageId);
    } else {
      clientMessageId = stage(sessionKey, { prompt, attachments });
    }
    try {
      await api.prompt({
        agent: target.agent,
        sessionId: target.sessionId,
        prompt,
        attachments: attachments.map(toPromptAttachment),
        clientMessageId,
      });
    } catch (e) {
      // Failed prompt start leaves queued prompts for explicit retry.
      canceledSessions.delete(sessionKey);
      runtime.finishThought(sessionKey);
      runtime.setError(sessionKey, e.message);
      runtime.setPending(sessionKey, false);
      resolveTurnWaiters(sessionKey);
    }
  };

  /** After a successful turn, auto-send the next queued prompt in order. */
  const drainQueue = (sessionKey: string) => {
    if (state.pendingIds.includes(sessionKey) || !runtime.isSubscribed(sessionKey)) return;
    const [next, ...rest] = runtime.getPane(sessionKey)?.queue ?? [];
    if (!next) return;
    runtime.setPane(sessionKey, { queue: rest });
    run(sessionKey, next);
  };

  /** Abort one in-flight turn and decline any permission it is awaiting. */
  const abort = async (sessionKey: string) => {
    decidePermission(sessionKey, null);
    if (!state.pendingIds.includes(sessionKey)) return;
    const target = runtime.target(sessionKey);
    if (!target) return;
    canceledSessions.add(sessionKey);
    const done = waitForTurnEnd(sessionKey);
    try {
      const result = await api.cancelPrompt(target.sessionId, target.agent);
      if (result?.cancelled === false) {
        handleTurnEnded(sessionKey, { cancelled: true });
        return;
      }
    } catch (e) {
      canceledSessions.delete(sessionKey);
      runtime.setError(sessionKey, e.message);
      return;
    }
    await done;
  };

  /** Accept a composer send: deliver it when idle, queue it during a turn. */
  const send = ({ prompt, attachments }: PromptPayload) => {
    const sessionKey = state.sessionKey;
    if ((!prompt && !attachments.length) || !sessionKey) return;
    if (state.pendingIds.includes(sessionKey)) {
      runtime.setPane(sessionKey, {
        queue: [...(runtime.getPane(sessionKey)?.queue ?? []), { id: crypto.randomUUID(), prompt, attachments }],
      });
      return;
    }
    if (state.loadingIds.includes(sessionKey)) return;
    if (runtime.record(sessionKey)?.draft) {
      return startDraftTurn(sessionKey, { prompt, attachments });
    }
    if (!runtime.isSubscribed(sessionKey)) return;
    run(sessionKey, { prompt, attachments });
  };

  /** Send one queued prompt now, canceling the current turn first if needed. */
  const flushQueued = async (sessionKey: string, itemId: string) => {
    if (!runtime.record(sessionKey)?.draft && !runtime.isSubscribed(sessionKey)) return;
    const item = (runtime.getPane(sessionKey)?.queue ?? []).find((entry) => entry.id === itemId);
    if (!item) return;
    if (!state.pendingIds.includes(sessionKey)) {
      runtime.setPane(sessionKey, {
        queue: (runtime.getPane(sessionKey)?.queue ?? []).filter((entry) => entry.id !== itemId),
      });
      run(sessionKey, item);
      return;
    }
    await abort(sessionKey);
    if (state.pendingIds.includes(sessionKey)) return;
    const queue = runtime.getPane(sessionKey)?.queue ?? [];
    if (!queue.some((entry) => entry.id === itemId)) return;
    runtime.setPane(sessionKey, { queue: queue.filter((entry) => entry.id !== itemId) });
    run(sessionKey, item);
  };

  const removeQueued = (sessionKey: string, itemId: string) => {
    runtime.setPane(sessionKey, {
      queue: (runtime.getPane(sessionKey)?.queue ?? []).filter((entry) => entry.id !== itemId),
    });
  };

  const updateQueued = (sessionKey: string, { id, prompt, attachments }: QueueItem) => {
    const queue = runtime.getPane(sessionKey)?.queue ?? [];
    const next = queue.some((entry) => entry.id === id)
      ? queue.map((entry) => (entry.id === id ? { id, prompt, attachments } : entry))
      : [...queue, { id, prompt, attachments }];
    runtime.setPane(sessionKey, { queue: next });
  };

  const clearSession = (sessionKey: string) => {
    canceledSessions.delete(sessionKey);
    clearLocalPermission(sessionKey);
    runtime.setPending(sessionKey, false);
    resolveTurnWaiters(sessionKey);
  };

  return {
    handleUserInput,
    handleUserInputResolved,
    syncSessionPermissions,
    handleTurnEnded,
    decidePermission,
    clearSession,
    stage,
    send,
    cancel: () => state.sessionKey && abort(state.sessionKey),
    run,
    abort,
    flushQueued,
    removeQueued,
    updateQueued,
  };
}
