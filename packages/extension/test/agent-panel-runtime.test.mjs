import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

let storage = {};
globalThis.chrome = {
  i18n: {
    getMessage: (key) => key,
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/' }],
  },
  storage: {
    local: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (patch) => Object.assign(storage, patch),
    },
  },
};

const { AGENT_PANEL_STATE_KEY, agentSessionKey } = await import('../shared/agent-session-store');
const { createSessionController } = await import('../pages/agent-panel/session-controller');
const { createSessionRuntime, reduceSessionEvent } = await import('../pages/agent-panel/session-runtime');
const { createTurnController } = await import('../pages/agent-panel/turn-controller');

function createPanelState(patch = {}) {
  const state = (next) => Object.assign(state, next);
  return Object.assign(state, {
    sessions: [],
    draftSession: null,
    defaults: { agent: '', configOptionsByAgent: {} },
    sessionKey: null,
    messages: [],
    configOptions: [],
    queue: [],
    pendingIds: [],
    loadingIds: [],
    deleting: null,
    error: '',
    sessionErrors: {},
    cwd: '',
    newSessionOpen: false,
    permissions: {},
    ...patch,
  });
}

const noopTurns = {
  run() {},
  abort: async () => {},
  decidePermission() {},
  syncSessionPermissions() {},
  handleTurnEnded() {},
  clearSession() {},
};

beforeEach(() => {
  storage = {};
});

describe('agent panel runtime', () => {
  it('reduces streamed chunks, thoughts, and tool updates without losing order', () => {
    let pane = { messages: [], configOptions: [] };
    let seq = 0;
    const apply = (update) => {
      const result = reduceSessionEvent(pane, { seq: ++seq, event: 'session_update', update });
      if (result?.pane) pane = { ...pane, ...result.pane };
      return result;
    };

    apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
    apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } });
    apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Think' } });
    apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ing' } });
    apply({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read' });
    apply({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });

    assert.deepEqual(
      pane.messages.map((message) => message.type || message.role),
      ['agent', 'thought', 'tool', 'event'],
    );
    assert.equal(pane.messages[0].text, 'Hello world');
    assert.deepEqual(pane.messages[1], { type: 'thought', text: 'Thinking', pending: false });
    assert.equal(pane.messages[2].data.status, 'completed');

    const info = apply({ sessionUpdate: 'session_info_update', title: 'ACP title', updatedAt: '2026-08-26' });
    assert.deepEqual(info.session, { title: 'ACP title', updatedAt: '2026-08-26' });
  });

  it('filters Claude Code cancellation markers and deduplicates optimistic user prompts', () => {
    const state = { messages: [], configOptions: [] };
    const interrupted = {
      seq: 1,
      event: 'session_update',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '[Request interrupted by user]' },
      },
    };

    assert.equal(reduceSessionEvent(state, interrupted, { agent: 'claude-acp' }), null);
    assert.deepEqual(reduceSessionEvent(state, interrupted, { agent: 'codex-acp' })?.pane.messages, [
      { role: 'user', text: '[Request interrupted by user]' },
    ]);
    assert.deepEqual(
      reduceSessionEvent(
        state,
        {
          seq: 2,
          event: 'session_update',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Why did Claude show [Request interrupted by user]?' },
          },
        },
        { agent: 'claude-acp' },
      )?.pane.messages,
      [{ role: 'user', text: 'Why did Claude show [Request interrupted by user]?' }],
    );

    const echoed = {
      seq: 3,
      event: 'session_update',
      update: {
        sessionUpdate: 'user_message_chunk',
        clientMessageId: 'msg-1',
        content: { type: 'text', text: 'Already staged' },
      },
    };
    assert.equal(reduceSessionEvent(state, echoed, { optimisticMessageIds: new Set(['msg-1']) }), null);
    assert.deepEqual(reduceSessionEvent(state, echoed, { optimisticMessageIds: new Set() })?.pane.messages, [
      { id: 'msg-1', role: 'user', text: 'Already staged' },
    ]);
  });

  it('shows a draft prompt immediately and keeps responding while the ACP session is created', async () => {
    const state = createPanelState();
    const runtime = createSessionRuntime(state);
    let resolveCreate;
    let onCreateStarted;
    const createStarted = new Promise((resolve) => {
      onCreateStarted = resolve;
    });
    const askCalls = [];
    const api = {
      createSession: () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
          onCreateStarted();
        }),
      setSessionConfigOption: async () => ({ configOptions: [] }),
      closeSession: async () => true,
      prompt: async (options) => {
        askCalls.push(options);
        return { ok: true, agent: options.agent, sessionId: options.sessionId };
      },
    };
    let controller;
    const turns = createTurnController({
      state,
      runtime,
      api,
      scrollToLatest() {},
      startDraftTurn: (...args) => controller.startDraftTurn(...args),
    });
    controller = createSessionController({ state, runtime, turns, api });

    controller.confirmNewSession({ agent: 'codex-acp', cwd: '/repo' });
    const starting = turns.send({ prompt: 'First prompt', attachments: [] });

    assert.equal(state.sessionKey, 'draft');
    assert.deepEqual(state.messages, [{ role: 'user', text: 'First prompt', attachments: [] }]);
    assert.deepEqual(state.pendingIds, ['draft']);
    assert.deepEqual(state.loadingIds, ['draft']);

    turns.send({ prompt: 'Queued while creating', attachments: [] });
    assert.equal(state.queue[0].prompt, 'Queued while creating');

    await createStarted;
    resolveCreate({ sessionId: 'acp-1', epoch: 'ep-1', seq: 0, title: 'ACP title', configOptions: [] });
    await starting;

    const key = agentSessionKey('codex-acp', 'acp-1');
    assert.equal(state.draftSession, null);
    assert.equal(state.sessionKey, key);
    assert.equal(state.sessions[0].title, 'ACP title');
    assert.deepEqual(state.messages, [{ role: 'user', text: 'First prompt', attachments: [] }]);
    assert.deepEqual(state.pendingIds, [key]);
    assert.deepEqual(state.loadingIds, []);
    assert.equal(state.queue[0].prompt, 'Queued while creating');
    assert.equal(askCalls[0].prompt, 'First prompt');
    assert.ok(askCalls[0].clientMessageId);

    // Daemon echoes user prompt with clientMessageId (deduped), streams answer, then ends turn.
    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      event: { seq: 1, event: 'turn_started' },
    });
    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      event: {
        seq: 2,
        event: 'session_update',
        update: {
          sessionUpdate: 'user_message_chunk',
          clientMessageId: askCalls[0].clientMessageId,
          content: { type: 'text', text: 'First prompt' },
        },
      },
    });
    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      event: {
        seq: 3,
        event: 'session_update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First answer' } },
      },
    });
    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      event: { seq: 4, event: 'turn_ended', stopReason: 'end_turn' },
    });
    await new Promise(setImmediate);

    assert.equal(askCalls[1].prompt, 'Queued while creating');
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ['user', 'agent', 'user'],
    );

    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      event: {
        seq: 5,
        event: 'session_update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second answer' } },
      },
    });
    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      event: { seq: 6, event: 'turn_ended', stopReason: 'end_turn' },
    });
    await new Promise(setImmediate);

    assert.deepEqual(state.pendingIds, []);
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ['user', 'agent', 'user', 'agent'],
    );
  });

  it('ignores a stale open superseded by reconnect resync', async () => {
    const key = agentSessionKey('codex-acp', 'acp-1');
    const state = createPanelState({
      sessions: [{ key, agent: 'codex-acp', sessionId: 'acp-1', cwd: '/repo' }],
    });
    const runtime = createSessionRuntime(state);
    let resolveFirstOpen;
    let openCount = 0;
    let onFirstOpenStarted;
    const firstOpenStarted = new Promise((resolve) => {
      onFirstOpenStarted = resolve;
    });
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        openSession: () => {
          openCount += 1;
          if (openCount === 1) {
            onFirstOpenStarted();
            return new Promise((resolve) => (resolveFirstOpen = resolve));
          }
          return Promise.resolve({
            agent: 'codex-acp',
            sessionId: 'acp-1',
            epoch: 'ep-2',
            seq: 0,
            configOptions: [{ id: 'model' }],
            running: false,
            userInputs: [],
            fullReplay: true,
            freshLoad: true,
          });
        },
      },
    });

    const staleOpen = controller.openSession(key);
    await firstOpenStarted;
    controller.markAllUnsubscribed();
    await controller.resyncCurrentSession();
    resolveFirstOpen({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      seq: 0,
      configOptions: [{ id: 'stale' }],
      running: false,
      userInputs: [],
      fullReplay: true,
      freshLoad: true,
    });
    await staleOpen;

    assert.equal(openCount, 2);
    assert.equal(state.sessionKey, key);
    assert.deepEqual(state.configOptions, [{ id: 'model' }]);
  });

  it("re-applies the agent's saved config only when freshLoad is true", async () => {
    const key = agentSessionKey('claude-acp', 'acp-1');
    const select = (id, currentValue) => ({
      id,
      type: 'select',
      currentValue,
      options: [{ value: 'a' }, { value: 'b' }],
    });
    const state = createPanelState({
      sessions: [{ key, agent: 'claude-acp', sessionId: 'acp-1' }],
      defaults: { agent: '', configOptionsByAgent: { 'claude-acp': [select('mode', 'b'), select('model', 'a')] } },
    });
    const calls = [];
    let freshLoad = true;
    const controller = createSessionController({
      state,
      runtime: createSessionRuntime(state),
      turns: noopTurns,
      api: {
        openSession: async () => ({
          agent: 'claude-acp',
          sessionId: 'acp-1',
          epoch: 'ep-1',
          seq: 0,
          configOptions: [select('mode', 'a'), select('model', 'a')],
          running: false,
          userInputs: [],
          fullReplay: true,
          freshLoad,
        }),
        setSessionConfigOption: async (agent, sessionId, configId, value) => {
          calls.push([agent, sessionId, configId, value]);
          return { configOptions: [select('mode', value), select('model', 'a')] };
        },
      },
    });

    await controller.openSession(key);

    assert.deepEqual(calls, [['claude-acp', 'acp-1', 'mode', 'b']]);
    assert.deepEqual(
      state.configOptions.map((option) => option.currentValue),
      ['b', 'a'],
    );

    // Reopening a live session (freshLoad: false) keeps its active daemon config.
    freshLoad = false;
    await controller.openSession(key, { force: true });
    assert.equal(calls.length, 1);
  });

  it('incrementally catches up on reconnect and buffers live events during openSession', async () => {
    const key = agentSessionKey('codex-acp', 'acp-1');
    const state = createPanelState({
      sessions: [{ key, agent: 'codex-acp', sessionId: 'acp-1', cwd: '/repo' }],
    });
    const runtime = createSessionRuntime(state);
    const openRequests = [];
    let resolveReconnectOpen;
    let onReconnectOpenStarted;
    const reconnectOpenStarted = new Promise((resolve) => {
      onReconnectOpenStarted = resolve;
    });
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        openSession: (options) => {
          openRequests.push(options);
          if (openRequests.length === 1) {
            options.onEvent?.({
              seq: 1,
              event: 'session_update',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1' } },
            });
            return Promise.resolve({
              agent: 'codex-acp',
              sessionId: 'acp-1',
              epoch: 'ep-1',
              seq: 1,
              configOptions: [],
              running: true,
              userInputs: [],
              fullReplay: true,
              freshLoad: true,
            });
          }
          onReconnectOpenStarted();
          return new Promise((resolve) => {
            resolveReconnectOpen = () => {
              options.onEvent?.({
                seq: 2,
                event: 'session_update',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Part 2' } },
              });
              resolve({
                agent: 'codex-acp',
                sessionId: 'acp-1',
                epoch: 'ep-1',
                seq: 2,
                configOptions: [],
                running: true,
                userInputs: [],
                fullReplay: false,
                freshLoad: false,
              });
            };
          });
        },
      },
    });

    await controller.openSession(key);
    assert.equal(state.messages[0].text, 'Part 1');
    assert.deepEqual(state.pendingIds, [key]);

    // Disconnect then reconnect: incremental catch-up requests sinceEpoch/sinceSeq.
    controller.markAllUnsubscribed();
    const resync = controller.openSession(key, { force: true });
    await reconnectOpenStarted;
    // Live event arrives while openSession is still in flight.
    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-1',
      event: {
        seq: 3,
        event: 'session_update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Part 3' } },
      },
    });
    resolveReconnectOpen();
    await resync;

    assert.equal(openRequests[1].sinceEpoch, 'ep-1');
    assert.equal(openRequests[1].sinceSeq, 1);
    assert.equal(state.messages[0].text, 'Part 1 Part 2 Part 3');
  });

  it('stays on the selected session and records the error when openSession fails', async () => {
    const previousKey = agentSessionKey('codex-acp', 'prev');
    const targetKey = agentSessionKey('codex-acp', 'target');
    const sessions = [
      { key: previousKey, agent: 'codex-acp', sessionId: 'prev' },
      { key: targetKey, agent: 'codex-acp', sessionId: 'target' },
    ];
    const state = createPanelState({ sessions, sessionKey: previousKey });
    const runtime = createSessionRuntime(state);
    runtime.setCachedPane(previousKey, {
      messages: [{ role: 'agent', text: 'Previous' }],
      configOptions: [],
      cwd: '/prev',
      queue: [],
    });
    runtime.setSync(previousKey, { epoch: 'ep-prev', lastSeq: 1, subscribed: true });
    let openShouldFail = true;
    let openAttempts = 0;
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        openSession: () => {
          openAttempts += 1;
          if (openShouldFail) return Promise.reject(new Error('Session not found'));
          return Promise.resolve({
            agent: 'codex-acp',
            sessionId: 'target',
            epoch: 'ep-target',
            seq: 0,
            configOptions: [{ id: 'model' }],
            running: false,
            userInputs: [],
            fullReplay: true,
            freshLoad: true,
          });
        },
      },
    });

    await controller.openSession(targetKey);

    assert.equal(state.sessionKey, targetKey);
    assert.equal(state.sessionErrors[targetKey], 'Session not found');
    assert.equal(state.loadingIds.includes(targetKey), false);
    assert.equal(runtime.hasCachedPane(targetKey), false);

    // Clicking target session again retries opening
    openShouldFail = false;
    await controller.openSession(targetKey);

    assert.equal(openAttempts, 2);
    assert.equal(state.sessionKey, targetKey);
    assert.equal(state.sessionErrors[targetKey], undefined);
    assert.equal(runtime.hasCachedPane(targetKey), true);
    assert.deepEqual(state.configOptions, [{ id: 'model' }]);
  });

  it('activates the previous list item when deleting the current session', async () => {
    const previousKey = agentSessionKey('codex-acp', 'previous');
    const currentKey = agentSessionKey('codex-acp', 'current');
    const nextKey = agentSessionKey('codex-acp', 'next');
    const sessions = [
      { key: previousKey, agent: 'codex-acp', sessionId: 'previous' },
      { key: currentKey, agent: 'codex-acp', sessionId: 'current' },
      { key: nextKey, agent: 'codex-acp', sessionId: 'next' },
    ];
    storage[AGENT_PANEL_STATE_KEY] = {
      sessions,
      defaults: { agent: 'codex-acp', configOptionsByAgent: {} },
    };
    const state = createPanelState({ sessions, sessionKey: currentKey });
    const runtime = createSessionRuntime(state);
    runtime.setCachedPane(previousKey, {
      messages: [{ role: 'agent', text: 'Previous session' }],
      configOptions: [],
      cwd: '/previous',
      queue: [],
    });
    runtime.setSync(previousKey, { epoch: 'ep-prev', lastSeq: 1, subscribed: true });
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        closeSession: async () => true,
        deleteSession: async () => true,
      },
    });

    await controller.deleteSession(currentKey);

    assert.equal(state.sessionKey, previousKey);
    assert.equal(state.messages[0].text, 'Previous session');
    assert.deepEqual(
      state.sessions.map((session) => session.key),
      [previousKey, nextKey],
    );
  });

  it('removes the session locally and activates fallback even if agent deleteSession fails', async () => {
    const previousKey = agentSessionKey('codex-acp', 'previous');
    const currentKey = agentSessionKey('codex-acp', 'current');
    const sessions = [
      { key: previousKey, agent: 'codex-acp', sessionId: 'previous' },
      { key: currentKey, agent: 'codex-acp', sessionId: 'current' },
    ];
    storage[AGENT_PANEL_STATE_KEY] = {
      sessions,
      defaults: { agent: 'codex-acp', configOptionsByAgent: {} },
    };
    const state = createPanelState({
      sessions,
      sessionKey: currentKey,
      sessionErrors: { [currentKey]: 'session is archived' },
    });
    const runtime = createSessionRuntime(state);
    runtime.setCachedPane(previousKey, {
      messages: [{ role: 'agent', text: 'Previous session' }],
      configOptions: [],
      cwd: '/previous',
      queue: [],
    });
    runtime.setSync(previousKey, { epoch: 'ep-prev', lastSeq: 1, subscribed: true });
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        closeSession: async () => true,
        deleteSession: () => Promise.reject(new Error('session is archived')),
      },
    });

    await controller.deleteSession(currentKey);

    assert.equal(state.sessionKey, previousKey);
    assert.equal(state.error, '');
    assert.equal(state.sessionErrors[currentKey], undefined);
    assert.equal(state.sessionErrors[previousKey], undefined);
    assert.deepEqual(
      state.sessions.map((session) => session.key),
      [previousKey],
    );
  });

  it('keeps queued prompts after cancel instead of auto-draining them', async () => {
    const key = agentSessionKey('codex-acp', 'acp-1');
    const state = createPanelState({
      sessions: [{ key, agent: 'codex-acp', sessionId: 'acp-1', title: 'Session' }],
      sessionKey: key,
    });
    const runtime = createSessionRuntime(state);
    runtime.setSync(key, { subscribed: true });
    let askCount = 0;
    let turns;
    turns = createTurnController({
      state,
      runtime,
      scrollToLatest() {},
      startDraftTurn() {},
      api: {
        prompt: async (options) => {
          askCount += 1;
          return { ok: true, agent: options.agent, sessionId: options.sessionId };
        },
        cancelPrompt: async () => {
          turns.handleTurnEnded(key, { cancelled: true });
          return { cancelled: true };
        },
      },
    });

    turns.send({ prompt: 'First', attachments: [] });
    turns.send({ prompt: 'Second', attachments: [] });
    assert.equal(state.queue.length, 1);

    await turns.abort(key);

    assert.equal(askCount, 1);
    assert.equal(state.pendingIds.length, 0);
    assert.equal(state.queue[0].prompt, 'Second');
  });

  it('blocks send and config changes while disconnected or resyncing', async () => {
    const key = agentSessionKey('codex-acp', 'acp-1');
    const session = { key, agent: 'codex-acp', sessionId: 'acp-1', title: 'Session' };
    storage = {
      [AGENT_PANEL_STATE_KEY]: { relayId: '', sessions: [session], defaults: { agent: '', configOptionsByAgent: {} } },
    };
    const state = createPanelState({
      sessions: [session],
      sessionKey: key,
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'code',
          options: [
            { value: 'code', name: 'Code' },
            { value: 'ask', name: 'Ask' },
          ],
        },
      ],
    });
    const runtime = createSessionRuntime(state);
    let promptCalls = 0;
    let configCalls = 0;
    const api = {
      openSession: async () => ({
        epoch: 'ep-1',
        seq: 0,
        fullReplay: false,
        running: false,
        userInputs: [],
        configOptions: state.configOptions,
      }),
      prompt: async (options) => {
        promptCalls += 1;
        return { ok: true, agent: options.agent, sessionId: options.sessionId };
      },
      setSessionConfigOption: async () => {
        configCalls += 1;
        return { configOptions: state.configOptions };
      },
    };
    const turns = createTurnController({
      state,
      runtime,
      scrollToLatest() {},
      startDraftTurn() {},
      api,
    });
    const sessions = createSessionController({ state, runtime, turns, api });

    runtime.setSync(key, { epoch: 'ep-1', lastSeq: 0, subscribed: true });
    sessions.markAllUnsubscribed();
    assert.equal(runtime.isSubscribed(key), false);

    turns.send({ prompt: 'Blocked while unsubscribed', attachments: [] });
    await sessions.changeConfig('mode', 'ask');
    assert.equal(promptCalls, 0);
    assert.equal(configCalls, 0);
    assert.equal(state.configOptions[0].currentValue, 'code');

    await sessions.openSession(key, { force: true });
    assert.equal(runtime.isSubscribed(key), true);

    turns.send({ prompt: 'Allowed after resync', attachments: [] });
    await sessions.changeConfig('mode', 'ask');
    assert.equal(promptCalls, 1);
    assert.equal(configCalls, 1);
  });

  it('ignores foreign user-input broadcasts and declines elicitations only for subscribed sessions', () => {
    const key = agentSessionKey('claude-acp', 'panel-1');
    const session = { key, agent: 'claude-acp', sessionId: 'panel-1', title: 'Panel session' };
    const state = createPanelState({ sessions: [session], sessionKey: key });
    const runtime = createSessionRuntime(state);
    const responses = [];
    const turns = createTurnController({
      state,
      runtime,
      scrollToLatest() {},
      startDraftTurn() {},
      api: {
        respondUserInput: async (params, response) => {
          responses.push({ params, response });
          return { ok: true };
        },
      },
    });

    // Foreign App session: neither elicitation nor permission should be touched.
    turns.handleUserInput({
      method: 'agent_elicitation_request',
      params: { agent: 'claude-acp', sessionId: 'app-only', requestId: 'e-foreign' },
    });
    turns.handleUserInput({
      method: 'agent_permission_request',
      params: { agent: 'claude-acp', sessionId: 'app-only', requestId: 'p-foreign', options: [] },
    });
    assert.equal(responses.length, 0);
    assert.deepEqual(state.permissions, {});

    // Unsubscribed local session: permission is recorded, elicitation is NOT auto-declined.
    turns.handleUserInput({
      method: 'agent_elicitation_request',
      params: { agent: 'claude-acp', sessionId: 'panel-1', requestId: 'e-unsub' },
    });
    turns.handleUserInput({
      method: 'agent_permission_request',
      params: { agent: 'claude-acp', sessionId: 'panel-1', requestId: 'p-local', options: [] },
    });
    assert.equal(responses.length, 0);
    assert.equal(state.permissions[key]?.requestId, 'p-local');

    // Subscribed panel session: elicitation is auto-declined so the panel turn does not stall.
    runtime.setSync(key, { epoch: 'ep-1', lastSeq: 1, subscribed: true });
    turns.handleUserInput({
      method: 'agent_elicitation_request',
      params: { agent: 'claude-acp', sessionId: 'panel-1', requestId: 'e-sub' },
    });
    assert.equal(responses.length, 1);
    assert.equal(responses[0].params.requestId, 'e-sub');
    assert.deepEqual(responses[0].response, { action: 'decline' });
  });

  it('resets lastSeq on fullReplay after daemon restart so lower-seq live events are not dropped', async () => {
    const key = agentSessionKey('codex-acp', 'acp-1');
    const session = { key, agent: 'codex-acp', sessionId: 'acp-1', title: 'Restarted' };
    const state = createPanelState({ sessions: [session], sessionKey: key });
    const runtime = createSessionRuntime(state);
    runtime.setSync(key, { epoch: 'ep-old', lastSeq: 50, subscribed: false });

    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        openSession: async (options) => {
          options.onEvent?.({
            seq: 1,
            event: 'session_update',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'History' } },
          });
          return {
            agent: 'codex-acp',
            sessionId: 'acp-1',
            epoch: 'ep-new',
            seq: 1,
            configOptions: [],
            running: true,
            userInputs: [],
            fullReplay: true,
            freshLoad: true,
          };
        },
      },
    });

    await controller.openSession(key, { force: true });
    assert.equal(runtime.getSync(key)?.epoch, 'ep-new');
    assert.equal(runtime.getSync(key)?.lastSeq, 1);

    controller.handleSessionEvent({
      agent: 'codex-acp',
      sessionId: 'acp-1',
      epoch: 'ep-new',
      event: {
        seq: 2,
        event: 'session_update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' + Live' } },
      },
    });
    assert.equal(state.messages[0].text, 'History + Live');
    assert.equal(runtime.getSync(key)?.lastSeq, 2);
  });

  it('settles abort immediately when daemon reports cancelled: false', async () => {
    const key = agentSessionKey('codex-acp', 'acp-1');
    const state = createPanelState({
      sessions: [{ key, agent: 'codex-acp', sessionId: 'acp-1', title: 'Session' }],
      sessionKey: key,
      pendingIds: [key],
    });
    const runtime = createSessionRuntime(state);
    const turns = createTurnController({
      state,
      runtime,
      scrollToLatest() {},
      startDraftTurn() {},
      api: {
        cancelPrompt: async () => ({ cancelled: false }),
      },
    });

    await turns.abort(key);
    assert.deepEqual(state.pendingIds, []);
  });

  it('does not drain queued prompts while unsubscribed and reconciles background sessions on reconnect', async () => {
    const currentKey = agentSessionKey('codex-acp', 'current');
    const bgDoneKey = agentSessionKey('codex-acp', 'bg-done');
    const bgRunningKey = agentSessionKey('codex-acp', 'bg-running');
    const sessionsList = [
      { key: currentKey, agent: 'codex-acp', sessionId: 'current', title: 'Current' },
      { key: bgDoneKey, agent: 'codex-acp', sessionId: 'bg-done', title: 'Bg Done' },
      { key: bgRunningKey, agent: 'codex-acp', sessionId: 'bg-running', title: 'Bg Running' },
    ];
    const state = createPanelState({
      sessions: sessionsList,
      sessionKey: currentKey,
      pendingIds: [bgDoneKey],
      permissions: {
        [bgDoneKey]: { agent: 'codex-acp', sessionId: 'bg-done', requestId: 'stale-perm', options: [] },
      },
    });
    const runtime = createSessionRuntime(state);
    runtime.setCachedPane(bgDoneKey, {
      messages: [],
      configOptions: [],
      cwd: '',
      queue: [{ id: 'q1', prompt: 'Queued while disconnected', attachments: [] }],
    });
    let promptCalls = 0;
    const api = {
      prompt: async () => {
        promptCalls += 1;
        return { ok: true };
      },
      openSession: async () => ({
        agent: 'codex-acp',
        sessionId: 'current',
        epoch: 'ep-cur',
        seq: 0,
        configOptions: [],
        running: false,
        userInputs: [],
        fullReplay: false,
        freshLoad: false,
      }),
      listActiveSessions: async () => ({
        sessions: [{ agent: 'codex-acp', sessionId: 'bg-running' }],
        userInputs: [
          {
            method: 'agent_permission_request',
            params: { agent: 'codex-acp', sessionId: 'bg-running', requestId: 'perm-run', options: [] },
          },
        ],
      }),
    };
    const turns = createTurnController({
      state,
      runtime,
      scrollToLatest() {},
      startDraftTurn() {},
      api,
    });
    const controller = createSessionController({ state, runtime, turns, api });

    // Unsubscribed session_state(running: false) settles pending without draining queue.
    controller.handleSessionState({ agent: 'codex-acp', sessionId: 'bg-done', running: false, completed: true });
    assert.equal(promptCalls, 0);
    assert.equal(runtime.getCachedPane(bgDoneKey)?.queue.length, 1);

    // Put bgDoneKey back as pending to test reconnect reconciliation via listActiveSessions.
    runtime.setPending(bgDoneKey, true);
    state({
      permissions: {
        [bgDoneKey]: { agent: 'codex-acp', sessionId: 'bg-done', requestId: 'stale-perm', options: [] },
      },
    });
    await controller.resyncCurrentSession();

    assert.equal(state.pendingIds.includes(bgDoneKey), false);
    assert.equal(state.pendingIds.includes(bgRunningKey), true);
    assert.equal(state.permissions[bgDoneKey], undefined);
    assert.equal(state.permissions[bgRunningKey]?.requestId, 'perm-run');
  });
});
