import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

async function running() {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'Review permissions');
  await tick();
  return fixture;
}

for (const outcome of ['completed', 'failed']) {
  test(`a ${outcome} task dismisses its pending permission and allows a new task`, async () => {
    const f = await running();
    const prompt = f.requests.at(-1);
    f.deliver({
      method: 'agent_permission_request',
      peerId: 1,
      params: {
        agent: 'codex',
        sessionId: 's1',
        requestId: 'p1',
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
    });
    await tick();
    assert.ok(f.app.getRuntime('s1').permission);
    if (outcome === 'failed') f.deliver({ id: prompt.payload.id, peerId: 1, error: 'Agent stopped' });
    else f.reply(prompt, { answer: 'Done' });
    await tick();
    assert.equal(f.app.getRuntime('s1').permission, undefined);
    // The host settles the request with the turn; nothing is answered.
    assert.equal(
      f.requests.find((request) => request.payload.method === 'agent_user_input_respond'),
      undefined,
    );
    assert.equal(f.app.runningSessionIds().length, 0);
    assert.equal(f.app.sendPrompt('s1', 'Next task'), true);
    await tick();
    f.reply(f.requests.at(-1), { answer: 'Next answer' });
    await tick();
    assert.equal(f.app.getMessages('s1').at(-1).text, 'Next answer');
  });
}

test('cancelling an unknown remote task shows the reset recovery path', async () => {
  const f = await running();
  f.app.cancelTurn('s1');
  await tick();
  const cancel = f.requests.at(-1);
  assert.equal(cancel.payload.method, 'agent_prompt_cancel');
  f.reply(cancel, { cancelled: false });
  await tick();
  f.app.hardResetApp();
  const fresh = documentFixture(f);
  await fresh.connect();
  await fresh.openSession();
  assert.equal(fresh.app.sendPrompt('s1', 'Recovered task'), true);
  await tick();
  fresh.reply(fresh.requests.at(-1), { answer: 'Recovered' });
  await tick();
  assert.equal(fresh.app.runningSessionIds().length, 0);
});

test('completed responses stay unread across list refreshes until read or a new prompt starts', async () => {
  const f = await running();
  assert.equal(Object.values(f.app.sessionsStore.runtimes).filter((runtime) => runtime.unread).length, 0);
  f.reply(f.requests.at(-1), { answer: 'Done' });
  await tick();
  assert.ok(Boolean(f.app.getRuntime('s1').unread));

  const refresh = f.app.refreshSessions();
  await f.settleHost();
  await refresh;
  assert.ok(Boolean(f.app.getRuntime('s1').unread));

  f.app.updateRuntime('s1', { unread: false });
  assert.equal(Object.values(f.app.sessionsStore.runtimes).filter((runtime) => runtime.unread).length, 0);
  assert.equal(f.app.sendPrompt('s1', 'Next task'), true);
  await tick();
  f.reply(f.requests.at(-1), { answer: 'Next answer' });
  await tick();
  assert.ok(Boolean(f.app.getRuntime('s1').unread));
  assert.equal(f.app.sendPrompt('s1', 'One more task'), true);
  assert.equal(Object.values(f.app.sessionsStore.runtimes).filter((runtime) => runtime.unread).length, 0);
});

for (const outcome of ['failed', 'cancelled', 'ended']) {
  test(`${outcome} responses do not create an unread completion reminder`, async () => {
    const f = await running();
    const prompt = f.requests.at(-1);
    if (outcome === 'failed') {
      f.deliver({ id: prompt.payload.id, peerId: 1, error: 'Agent stopped' });
    } else {
      if (outcome === 'cancelled') {
        f.app.cancelTurn('s1');
        await tick();
        f.reply(f.requests.at(-1), { cancelled: true });
        f.deliver({ id: prompt.payload.id, peerId: 1, event: { event: 'stop', stop_reason: 'cancelled' } });
      } else {
        f.deliver({ method: 'agent_session_ended', params: { agent: 'codex', sessionId: 's1' } });
      }
      f.reply(prompt, { answer: 'Partial response' });
    }
    await tick();
    assert.equal(f.app.runningSessionIds().length, 0);
    assert.equal(Object.values(f.app.sessionsStore.runtimes).filter((runtime) => runtime.unread).length, 0);
  });
}

test('newly created sessions receive completion reminders and resetting clears them', async () => {
  const f = documentFixture();
  await f.connect();
  const pendingSession = f.app.createPendingSession({ agent: 'codex', cwd: '/tmp' });
  const creating = f.app.promotePendingSession(pendingSession, 'First task');
  await f.settleHost();
  const session = await creating;
  f.reply(f.requests.at(-1), { answer: 'Done' });
  await tick();
  assert.ok(Boolean(f.app.getRuntime(session.sessionId).unread));
  f.app.resetRemoteState();
  assert.equal(Object.values(f.app.sessionsStore.runtimes).filter((runtime) => runtime.unread).length, 0);
});

test('pending permission requests expose active permission status for session list items', async () => {
  const f = await running();
  assert.equal(Object.keys(f.app.sessionsStore.runtimes).filter((id) => f.app.getRuntime(id).permission).length, 0);
  f.deliver({
    method: 'agent_permission_request',
    peerId: 1,
    params: {
      agent: 'codex',
      sessionId: 's1',
      requestId: 'p1',
      options: [{ optionId: 'allow', name: 'Allow' }],
    },
  });
  await tick();
  assert.deepEqual(
    Object.keys(f.app.sessionsStore.runtimes).filter((id) => f.app.getRuntime(id).permission),
    ['s1'],
  );
  assert.equal(f.app.isTurnRunning('s1'), true);

  f.app.resolvePermission('s1', 'allow');
  await tick();
  assert.equal(Object.keys(f.app.sessionsStore.runtimes).filter((id) => f.app.getRuntime(id).permission).length, 0);
  assert.equal(f.app.isTurnRunning('s1'), true);
});

test('createSession and loadSession pass remote_app panelContext', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();
  const loadReq = f.requests.find((r) => r.payload.method === 'agent_session_load');
  assert.ok(loadReq);
  assert.deepEqual(loadReq.payload.params.panelContext, { surface: 'remote_app' });

  const pendingSession = f.app.createPendingSession({ agent: 'codex', cwd: '/tmp' });
  const creating = f.app.promotePendingSession(pendingSession, 'First task');
  await f.settleHost();
  await creating;
  const createReq = f.requests.find((r) => r.payload.method === 'agent_session_create');
  assert.ok(createReq);
  assert.deepEqual(createReq.payload.params.panelContext, { surface: 'remote_app' });
});

test('pending sessions are independent, so discarding one keeps the next', async () => {
  const f = documentFixture();
  await f.connect();
  const first = f.app.createPendingSession({ agent: 'codex', cwd: '/tmp' });
  const next = f.app.createPendingSession({ agent: 'codex', cwd: '/tmp' });
  assert.notEqual(first.sessionId, next.sessionId);
  f.app.discardPendingSession(first.sessionId);
  assert.equal(f.app.getSession(first.sessionId), undefined);
  assert.equal(f.app.getSession(next.sessionId)?.pendingCreation, true);
});

test('a creation cancelled and sent again keeps only the later turn', async () => {
  const f = documentFixture();
  await f.connect();
  f.heldMethods.add('agent_session_create');
  const pendingSession = f.app.createPendingSession({ agent: 'codex', cwd: '/tmp' });
  const cancelled = f.app.promotePendingSession(pendingSession, 'First try');
  await tick();
  f.app.cancelTurn(pendingSession.sessionId);
  const resent = f.app.promotePendingSession(pendingSession, 'Second try');
  await tick();
  const [firstCreate, secondCreate] = f.requests.filter((r) => r.payload.method === 'agent_session_create');
  f.heldMethods.clear();

  f.reply(firstCreate, { sessionId: 'stale', agent: 'codex' });
  assert.equal(await cancelled, null);
  await f.settleHost();
  assert.equal(
    f.requests.findLast((r) => r.payload.method === 'agent_session_close').payload.params.sessionId,
    'stale',
  );
  assert.equal(f.app.isTurnRunning(pendingSession.sessionId), true);

  f.reply(secondCreate, { sessionId: 'created', agent: 'codex' });
  assert.equal((await resent).sessionId, 'created');
  await tick();
  const prompts = f.requests.filter((r) => r.payload.method === 'agent_prompt');
  assert.deepEqual(
    prompts.map((r) => r.payload.params.prompt),
    ['Second try'],
  );
});
