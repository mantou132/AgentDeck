import { agentSessionKey, sessionTitleFromPrompt } from '../../shared/agent-session-store.js';

export function createTurnController({ state, runtime, api, scrollToLatest, startDraftTurn }) {
  const runningTurns = new Map();
  const canceledSessions = new Set();

  /** Show a permission request of the host (a notification); keyed by session so
   * requests survive switching and are answered when their session shows. The panel
   * has no question card, so form elicitations are skipped (declined) at once. */
  const handleUserInput = ({ method, params }) => {
    if (method === 'agent_elicitation_request') {
      api.respondUserInput(params, { action: 'decline' }).catch(console.error);
      return;
    }
    const { agent, sessionId } = params;
    // The host waits for one request per session; a newer one replaces the card.
    state({ permissions: { ...state.permissions, [agentSessionKey(agent, sessionId)]: params } });
  };

  /** Answer the permission of one session through the host; `null` cancels the tool call. */
  const decidePermission = (sessionKey, optionId) => {
    const request = sessionKey && state.permissions[sessionKey];
    if (!request) return;
    const permissions = { ...state.permissions };
    delete permissions[sessionKey];
    state({ permissions });
    api.respondUserInput(request, optionId ? { optionId } : {}).catch(console.error);
  };

  const declineAllPermissions = () => {
    for (const sessionKey of Object.keys(state.permissions)) decidePermission(sessionKey, null);
  };

  /** Show a submitted prompt immediately, before the host starts answering. */
  const stage = (sessionKey, { prompt, attachments }) => {
    if (sessionKey === state.sessionKey) scrollToLatest?.();
    runtime.clearError(sessionKey);
    runtime.setPending(sessionKey, true);
    runtime.setPane(sessionKey, {
      messages: [...(runtime.getPane(sessionKey)?.messages ?? []), { role: 'user', text: prompt, attachments }],
    });
    const current = runtime.record(sessionKey);
    const title = current?.title ? '' : sessionTitleFromPrompt(prompt);
    runtime.patchRecord(sessionKey, {
      ...(title && { title }),
      updatedAt: new Date().toISOString(),
    });
  };

  /** Run one turn against the host; events keep following their session when
   * the user switches away. A newly materialized draft is already staged. */
  const performTurn = async (sessionKey, { prompt, attachments }, { staged = false } = {}) => {
    const target = runtime.target(sessionKey);
    if (!target) return;
    if (staged) {
      if (sessionKey === state.sessionKey) scrollToLatest?.();
      runtime.clearError(sessionKey);
      runtime.setPending(sessionKey, true);
    } else {
      stage(sessionKey, { prompt, attachments });
    }
    const turnStart = (runtime.getPane(sessionKey)?.messages ?? []).length;
    const wireAttachments = attachments.map((item) =>
      item.kind === 'image'
        ? { type: 'image', data: item.data, mimeType: item.mimeType }
        : { type: 'text', text: `<attachment name="${item.name}">\n${item.text}\n</attachment>` },
    );
    try {
      const result = await api.prompt(
        target.sessionId,
        target.agent,
        prompt,
        (event) => runtime.applyEvent(sessionKey, event),
        wireAttachments,
      );
      const answer = result?.answer || '';
      runtime.finishThought(sessionKey);
      const messages = runtime.getPane(sessionKey)?.messages ?? [];
      const receivedAgentText = messages.slice(turnStart).some((message) => message.role === 'agent' && message.text);
      if (answer && !receivedAgentText) {
        runtime.setPane(sessionKey, { messages: [...messages, { role: 'agent', text: answer }] });
      }
    } catch (e) {
      // Failed and canceled turns leave queued prompts for explicit retry.
      canceledSessions.delete(sessionKey);
      runtime.finishThought(sessionKey);
      runtime.setError(sessionKey, e.message);
      return;
    } finally {
      runtime.setPending(sessionKey, false);
    }
    if (!canceledSessions.delete(sessionKey)) drainQueue(sessionKey);
  };

  /** Track the settling promise so cancel-and-replace can await it. */
  const run = (sessionKey, payload, options) => {
    const turn = performTurn(sessionKey, payload, options)
      .catch(() => {})
      .finally(() => {
        if (runningTurns.get(sessionKey) === turn) runningTurns.delete(sessionKey);
      });
    runningTurns.set(sessionKey, turn);
  };

  /** After a successful turn, auto-send the next queued prompt in order. */
  const drainQueue = (sessionKey) => {
    if (state.pendingIds.includes(sessionKey)) return;
    const [next, ...rest] = runtime.getPane(sessionKey)?.queue ?? [];
    if (!next) return;
    runtime.setPane(sessionKey, { queue: rest });
    run(sessionKey, next);
  };

  /** Abort one in-flight turn and decline any permission it is awaiting. */
  const abort = async (sessionKey) => {
    decidePermission(sessionKey, null);
    const turn = runningTurns.get(sessionKey);
    if (!turn) return;
    const target = runtime.target(sessionKey);
    if (!target) return;
    canceledSessions.add(sessionKey);
    try {
      await api.cancelPrompt(target.sessionId, target.agent);
    } catch (e) {
      runtime.setError(sessionKey, e.message);
    }
    await turn;
  };

  /** Accept a composer send: deliver it when idle, queue it during a turn. */
  const send = ({ prompt, attachments }) => {
    const sessionKey = state.sessionKey;
    if ((!prompt && !attachments?.length) || !sessionKey) return;
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
    run(sessionKey, { prompt, attachments });
  };

  /** Send one queued prompt now, canceling the current turn first if needed. */
  const flushQueued = async (sessionKey, itemId) => {
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

  const removeQueued = (sessionKey, itemId) => {
    runtime.setPane(sessionKey, {
      queue: (runtime.getPane(sessionKey)?.queue ?? []).filter((entry) => entry.id !== itemId),
    });
  };

  const updateQueued = (sessionKey, { id, prompt, attachments }) => {
    const queue = runtime.getPane(sessionKey)?.queue ?? [];
    const next = queue.some((entry) => entry.id === id)
      ? queue.map((entry) => (entry.id === id ? { id, prompt, attachments } : entry))
      : [...queue, { id, prompt, attachments }];
    runtime.setPane(sessionKey, { queue: next });
  };

  return {
    handleUserInput,
    decidePermission,
    declineAllPermissions,
    clearCanceledSessions: () => canceledSessions.clear(),
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
