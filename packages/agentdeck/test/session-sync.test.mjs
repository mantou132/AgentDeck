import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, relayId, tick } from './helpers/app-fixture.mjs';

test('switching hosts while a session is running never closes or cancels it, and switching back resumes live stream', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  const untrack = fixture.app.trackSessionPage('s1');
  await fixture.openSession('s1');

  assert.equal(fixture.app.sendPrompt('s1', 'Write a hello world script'), true);
  await tick();
  const promptReq = fixture.requests.find((r) => r.payload.method === 'agent_prompt');
  assert.ok(promptReq, 'prompt request sent');
  const clientMessageId = promptReq.payload.params.clientMessageId;
  assert.ok(clientMessageId, 'prompt carries clientMessageId');
  fixture.reply(promptReq, { ok: true, agent: 'codex', sessionId: 's1' });

  // Daemon echoes user prompt with clientMessageId (must dedupe) and streams partial response.
  fixture.emitEvent('s1', { event: 'turn_started' });
  fixture.emitEvent('s1', {
    event: 'session_update',
    update: {
      sessionUpdate: 'user_message_chunk',
      clientMessageId,
      content: { type: 'text', text: 'Write a hello world script' },
    },
  });
  fixture.emitEvent('s1', {
    event: 'session_update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1' } },
  });
  await tick();
  assert.equal(fixture.app.getMessages('s1').length, 2, 'echoed user prompt is deduplicated');
  assert.equal(fixture.app.isTurnRunning('s1'), true);

  // Leave page and switch to another host (Host B).
  const reqsBeforeSwitch = fixture.requests.length;
  untrack();
  await tick();
  const relayChanged = fixture.app.saveSettings({
    relayId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    agent: 'codex',
  });
  assert.equal(relayChanged, true);
  fixture.sockets.at(-1).open();
  await fixture.settleHost();

  const switchMethods = fixture.requests.slice(reqsBeforeSwitch).map((r) => r.payload.method);
  assert.equal(switchMethods.includes('agent_session_close'), false, 'host switch must not close the running session');
  assert.equal(switchMethods.includes('agent_prompt_cancel'), false, 'host switch must not cancel the running turn');
  assert.equal(switchMethods.includes('agent_session_unsubscribe'), true, 'leaving page unsubscribes cleanly');

  // Switch back to original Host A: active session is discovered via agent_active_sessions.
  fixture.heldMethods.add('agent_active_sessions');
  fixture.heldMethods.add('agent_session_open');
  fixture.app.saveSettings({ relayId, agent: 'codex' });
  fixture.sockets.at(-1).open();
  await fixture.settleHost();

  const activeReq = fixture.requests.findLast((r) => r.payload.method === 'agent_active_sessions');
  assert.ok(activeReq, 'queries active sessions on host reconnect');
  fixture.reply(activeReq, {
    sessions: [{ agent: 'codex', sessionId: 's1', cwd: '/tmp', title: 'Reset test' }],
    userInputs: [],
  });
  await tick();
  assert.equal(fixture.app.isTurnRunning('s1'), true, 'running badge restored from daemon');

  // Re-enter session s1: opens idempotently without close, replays buffered events, then continues live.
  const untrackAgain = fixture.app.trackSessionPage('s1');
  const opening = fixture.app.ensureSessionLoaded('s1');
  await tick();
  const openReq = fixture.requests.findLast((r) => r.payload.method === 'agent_session_open');
  assert.ok(openReq);
  fixture.deliver({
    id: openReq.payload.id,
    peerId: 1,
    event: {
      events: [
        { seq: 1, event: 'turn_started' },
        {
          seq: 2,
          event: 'session_update',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Write a hello world script' },
          },
        },
        {
          seq: 3,
          event: 'session_update',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1 + Part 2' } },
        },
      ],
    },
  });
  fixture.reply(openReq, {
    agent: 'codex',
    sessionId: 's1',
    epoch: 'ep-1',
    seq: 3,
    running: true,
    userInputs: [],
    fullReplay: true,
    freshLoad: false,
  });
  await opening;

  assert.equal(fixture.app.isTurnRunning('s1'), true);
  assert.equal(fixture.app.getMessages('s1').at(-1).text, 'Part 1 + Part 2');

  // Remaining live chunks + turn_ended arrive and complete the turn.
  fixture.emitEvent(
    's1',
    {
      seq: 4,
      event: 'session_update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' + Part 3' } },
    },
    { epoch: 'ep-1' },
  );
  fixture.emitEvent('s1', { seq: 5, event: 'turn_ended', stopReason: 'end_turn' }, { epoch: 'ep-1' });
  await tick();

  assert.equal(fixture.app.isTurnRunning('s1'), false);
  assert.equal(fixture.app.getMessages('s1').at(-1).text, 'Part 1 + Part 2 + Part 3');
  assert.equal(Boolean(fixture.app.getRuntime('s1').unread), true);
  untrackAgain();
});

test('app restart reconciles active running sessions with remote list, keeping the active group at the top', async () => {
  const fresh = documentFixture();
  fresh.heldMethods.add('agent_session_list');
  fresh.heldMethods.add('agent_active_sessions');
  await fresh.connect();

  assert.equal(new URL(fresh.sockets[0].url).searchParams.get('ack_head'), 'true');
  assert.equal(fresh.app.sessionsStore.sessionsLoaded, false);

  const activeReq = fresh.requests.find((r) => r.payload.method === 'agent_active_sessions');
  fresh.reply(activeReq, {
    sessions: [
      {
        agent: 'codex',
        sessionId: 's1',
        cwd: '/tmp',
        title: 'Active task',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    ],
    userInputs: [],
  });
  const listReq = fresh.requests.find((r) => r.payload.method === 'agent_session_list');
  fresh.reply(listReq, {
    sessions: [
      {
        sessionId: 'old-1',
        cwd: '/projects/old-1',
        agent: 'codex',
        title: 'Old 1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        sessionId: 'old-2',
        cwd: '/projects/old-2',
        agent: 'codex',
        title: 'Old 2',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  });
  await tick();

  assert.equal(fresh.app.sessionsStore.sessionsLoaded, true);
  assert.equal(fresh.app.isTurnRunning('s1'), true);
  const groups = fresh.app.sessionsStore.sessionGroups;
  assert.ok(groups.length >= 2, 'contains both active and remote groups');
  assert.equal(groups[0].cwd, '/tmp', 'active running project group is at the top');
  assert.equal(
    groups[0].sessions.some((s) => s.sessionId === 's1'),
    true,
    'contains the active running session',
  );
});

test('reconnect incrementally catches up with sinceEpoch/sinceSeq and buffers live events during openSession', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  const untrack = fixture.app.trackSessionPage('s1');
  await fixture.openSession('s1');

  fixture.app.sendPrompt('s1', 'Stream smoothly');
  await tick();
  fixture.reply(fixture.requests.at(-1), { ok: true, agent: 'codex', sessionId: 's1' });
  fixture.emitEvent('s1', {
    seq: 1,
    event: 'session_update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } },
  });
  await tick();
  assert.equal(fixture.app.getMessages('s1').at(-1).text, 'A');

  // Reconnect while open page is mounted -> resyncOpenSessions sends sinceEpoch & sinceSeq.
  fixture.heldMethods.add('agent_session_open');
  fixture.heldMethods.add('agent_active_sessions');
  fixture.transport.reconnectTransport(true);
  await tick();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();

  const activeReq = fixture.requests.findLast((r) => r.payload.method === 'agent_active_sessions');
  fixture.reply(activeReq, { sessions: [{ agent: 'codex', sessionId: 's1' }], userInputs: [] });
  const reopen = fixture.requests.findLast((r) => r.payload.method === 'agent_session_open');
  assert.equal(reopen.payload.params.sinceEpoch, 'ep-1');
  assert.equal(reopen.payload.params.sinceSeq, 1);

  // Live event seq 3 arrives BEFORE openSession finishes returning seq 2!
  fixture.emitEvent('s1', {
    seq: 3,
    event: 'session_update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'C' } },
  });
  fixture.deliver({
    id: reopen.payload.id,
    peerId: 1,
    event: {
      seq: 2,
      event: 'session_update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B' } },
    },
  });
  fixture.reply(reopen, {
    agent: 'codex',
    sessionId: 's1',
    epoch: 'ep-1',
    seq: 2,
    running: true,
    userInputs: [],
    fullReplay: false,
    freshLoad: false,
  });
  await tick();

  assert.equal(fixture.app.getMessages('s1').at(-1).text, 'ABC');
  fixture.emitEvent('s1', { seq: 4, event: 'turn_ended', stopReason: 'end_turn' });
  await tick();
  assert.equal(fixture.app.isTurnRunning('s1'), false);
  untrack();
});

test('a background turn that finished while disconnected settles cleanly via agent_active_sessions', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession('s1');
  fixture.app.sendPrompt('s1', 'Long task');
  await tick();
  fixture.reply(fixture.requests.at(-1), { ok: true, agent: 'codex', sessionId: 's1' });
  await tick();
  assert.equal(fixture.app.isTurnRunning('s1'), true);

  // Reconnect after the turn was cancelled/failed while away (not marked unread on daemon).
  fixture.transport.reconnectTransport(true);
  await tick();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();

  assert.equal(fixture.app.isTurnRunning('s1'), false);
  assert.equal(fixture.app.runningSessionIds().length, 0);
  assert.equal(Boolean(fixture.app.getRuntime('s1').unread), false);

  // Reconnect after a turn actually completed on daemon while away, even if agent_session_list
  // resolves before agent_active_sessions clears the stale local running flag.
  fixture.app.updateRuntime('s1', { running: true });
  fixture.host.unreadSessions.add('s1');
  fixture.heldMethods.add('agent_active_sessions');
  fixture.transport.reconnectTransport(true);
  await tick();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  fixture.heldMethods.delete('agent_active_sessions');
  const activeReq = fixture.requests.findLast((r) => r.payload.method === 'agent_active_sessions');
  fixture.reply(activeReq, { sessions: [], userInputs: [] });
  await fixture.settleHost();

  assert.equal(fixture.app.isTurnRunning('s1'), false);
  assert.equal(Boolean(fixture.app.getRuntime('s1').unread), true);
});

test('sendPrompt and config changes wait until reconnect resync completes (and work again after retry)', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  const untrack = fixture.app.trackSessionPage('s1');
  fixture.heldMethods.add('agent_session_open');
  const firstOpen = fixture.app.ensureSessionLoaded('s1');
  await tick();
  fixture.reply(
    fixture.requests.findLast((r) => r.payload.method === 'agent_session_open'),
    {
      sessionId: 's1',
      agent: 'codex',
      epoch: 'ep-1',
      seq: 0,
      running: false,
      userInputs: [],
      fullReplay: true,
      freshLoad: true,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    },
  );
  await firstOpen;
  assert.equal(fixture.app.getRuntime('s1').subscribed, true);

  // Reconnect while agent_session_open is still in flight (e.g. evicted actor reloading from disk).
  fixture.transport.reconnectTransport(true);
  await tick();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();

  assert.equal(fixture.app.agentdeckStore.connection, 'connected');
  assert.equal(fixture.app.getRuntime('s1').load, 'loaded');
  assert.equal(fixture.app.getRuntime('s1').subscribed, false);
  assert.equal(fixture.app.sendPrompt('s1', 'Too early'), false, 'cannot send before resync subscribes');
  assert.equal(
    await fixture.app.changeSessionConfig(fixture.app.getSession('s1'), 'mode', 'plan'),
    false,
    'cannot change mode before resync subscribes',
  );

  // If that resync open fails, session stays loaded for reading but still blocks sending until retry succeeds.
  const failedOpen = fixture.requests.findLast((r) => r.payload.method === 'agent_session_open');
  fixture.deliver({ id: failedOpen.payload.id, error: 'Transient load error', peerId: 1 });
  await tick();
  assert.equal(fixture.app.getRuntime('s1').subscribed, false);
  assert.equal(fixture.app.getRuntime('s1').error, 'Transient load error');
  assert.equal(fixture.app.sendPrompt('s1', 'Still unsubscribed'), false);

  // Retry succeeds with a fresh epoch (evicted actor reloaded from disk) -> sending & config work again.
  fixture.heldMethods.delete('agent_session_open');
  const retry = fixture.app.retrySessionLoad('s1');
  await fixture.settleHost();
  await retry;
  assert.equal(fixture.app.getRuntime('s1').subscribed, true);
  assert.equal(fixture.app.sendPrompt('s1', 'Now ready'), true);
  await tick();
  fixture.reply(fixture.requests.at(-1), { ok: true, agent: 'codex', sessionId: 's1' });
  fixture.emitTurnAnswer('s1', 'Done', { epoch: fixture.app.getRuntime('s1').epoch });
  await tick();
  assert.equal(fixture.app.getMessages('s1').at(-1).text, 'Done');
  untrack();
});

test('promotePendingSession tracks config broadcasts during setup without triggering a seq gap resync', async () => {
  const fixture = documentFixture();
  await fixture.connect();

  const pending = fixture.app.createPendingSession({ agent: 'codex', cwd: '/repo' });
  fixture.app.updateRuntime(pending.sessionId, {
    options: {
      modes: {
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    },
  });

  const promoting = fixture.app.promotePendingSession(pending, 'First prompt');
  await tick();
  const createReq = fixture.requests.findLast((r) => r.payload.method === 'agent_session_create');
  fixture.reply(createReq, {
    sessionId: 's-new',
    epoch: 'ep-new',
    seq: 0,
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    },
  });
  await tick();

  // Daemon applies set_mode and broadcasts current_mode_update (seq 1) before replying.
  const modeReq = fixture.requests.findLast((r) => r.payload.method === 'agent_session_set_mode');
  assert.ok(modeReq);
  fixture.emitEvent(
    's-new',
    {
      seq: 1,
      event: 'session_update',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    },
    { epoch: 'ep-new' },
  );
  fixture.reply(modeReq, { ok: true });
  const live = await promoting;
  assert.equal(live?.sessionId, 's-new');
  assert.equal(fixture.app.getRuntime('s-new').lastSeq, 1);

  await tick();
  const promptReq = fixture.requests.findLast((r) => r.payload.method === 'agent_prompt');
  fixture.reply(promptReq, { ok: true, agent: 'codex', sessionId: 's-new' });
  fixture.emitEvent('s-new', { seq: 2, event: 'turn_started' }, { epoch: 'ep-new' });
  await tick();

  assert.equal(fixture.app.getRuntime('s-new').lastSeq, 2);
  assert.equal(
    fixture.requests.filter((r) => r.payload.method === 'agent_session_open').length,
    0,
    'must not trigger a redundant gap resync after config update broadcast',
  );
});

test('starting a new turn clears unread and trailing agent_session_state cannot re-mark a subscribed session', async () => {
  const fixture = documentFixture();
  await fixture.connect();

  // 1. Unsubscribed session finishes on another device -> unread (completed) is true.
  fixture.emitSessionState({
    agent: 'codex',
    sessionId: 's1',
    cwd: '/tmp',
    running: false,
    completed: true,
  });
  await tick();
  assert.equal(fixture.app.getRuntime('s1').running, false);
  assert.equal(fixture.app.getRuntime('s1').unread, true);

  // Another turn starts on the other device -> running clears the stale completed/unread mark.
  fixture.emitSessionState({
    agent: 'codex',
    sessionId: 's1',
    cwd: '/tmp',
    running: true,
    completed: false,
  });
  await tick();
  assert.equal(fixture.app.getRuntime('s1').running, true);
  assert.equal(fixture.app.getRuntime('s1').unread, false);

  // 2. Subscribed session finishes, user views it and sends a follow-up prompt on this device;
  // a trailing agent_session_state(completed: true) from the previous turn must not clobber running or re-mark unread.
  await fixture.openSession('s1');
  const epoch = fixture.app.getRuntime('s1').epoch;
  fixture.emitEvent('s1', { seq: 1, event: 'turn_ended', stopReason: 'end_turn' }, { epoch });
  await tick();
  assert.equal(fixture.app.getRuntime('s1').unread, true);

  fixture.app.updateRuntime('s1', { unread: false });
  assert.equal(fixture.app.sendPrompt('s1', 'Follow up'), true);
  await tick();
  fixture.reply(fixture.requests.at(-1), { ok: true, agent: 'codex', sessionId: 's1' });
  assert.equal(fixture.app.getRuntime('s1').running, true);
  assert.equal(fixture.app.getRuntime('s1').unread, false);

  fixture.emitSessionState({
    agent: 'codex',
    sessionId: 's1',
    cwd: '/tmp',
    running: false,
    completed: true,
  });
  await tick();
  assert.equal(fixture.app.getRuntime('s1').running, true);
  assert.equal(fixture.app.getRuntime('s1').unread, false);
});

test('leaving a session page while openSession is in flight unsubscribes once openSession resolves', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  fixture.heldMethods.add('agent_session_open');

  const untrack = fixture.app.trackSessionPage('s1');
  const opening = fixture.app.ensureSessionLoaded('s1');
  await tick();

  const openReq = fixture.requests.findLast((r) => r.payload.method === 'agent_session_open');
  assert.ok(openReq, 'openSession request sent');

  // User navigates away before openSession finishes.
  untrack();
  await tick();
  assert.equal(
    fixture.requests.some((r) => r.payload.method === 'agent_session_unsubscribe'),
    false,
    'does not unsubscribe before openSession registers the subscriber',
  );

  fixture.reply(openReq, {
    agent: 'codex',
    sessionId: 's1',
    epoch: 'ep-1',
    seq: 2,
    running: false,
    userInputs: [],
    fullReplay: true,
    freshLoad: false,
  });
  await opening;
  await tick();

  assert.equal(fixture.app.getRuntime('s1').subscribed, false, 'stays unsubscribed after late openSession');
  assert.equal(fixture.app.getRuntime('s1').load, 'loaded', 'keeps loaded snapshot for incremental re-entry');
  assert.equal(
    fixture.requests.some(
      (r) => r.payload.method === 'agent_session_unsubscribe' && r.payload.params.sessionId === 's1',
    ),
    true,
    'sends agent_session_unsubscribe once daemon subscribed the peer',
  );
});

test('agent_session_state updates session updatedAt and title from daemon without reverting', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  assert.equal(fixture.app.getSession('s1')?.updatedAt, undefined);

  fixture.emitSessionState({
    agent: 'codex',
    sessionId: 's1',
    cwd: '/tmp',
    title: 'Updated title',
    updatedAt: '2026-01-02T12:00:00.000Z',
    running: true,
    completed: false,
  });
  await tick();
  assert.equal(fixture.app.getSession('s1')?.title, 'Updated title');
  assert.equal(fixture.app.getSession('s1')?.updatedAt, '2026-01-02T12:00:00.000Z');

  fixture.emitSessionState({
    agent: 'codex',
    sessionId: 's1',
    cwd: '/tmp',
    title: 'Updated title',
    updatedAt: '2026-01-02T12:05:00.000Z',
    running: false,
    completed: true,
  });
  await tick();
  assert.equal(fixture.app.getSession('s1')?.updatedAt, '2026-01-02T12:05:00.000Z');
});
