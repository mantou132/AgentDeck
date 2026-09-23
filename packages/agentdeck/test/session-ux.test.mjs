import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

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
      id: 'permission',
      method: 'agent_permission_request',
      peerId: 1,
      params: {
        agent: 'codex',
        sessionId: 's1',
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
    });
    await tick();
    assert.ok(f.app.agentdeckStore.permissionsBySession.s1);
    if (outcome === 'failed') f.deliver({ id: prompt.payload.id, peerId: 1, error: 'Agent stopped' });
    else f.reply(prompt, { answer: 'Done' });
    await tick();
    assert.equal(f.app.agentdeckStore.permissionsBySession.s1, undefined);
    assert.ok(f.requests.find((request) => request.payload.id === 'permission')?.payload.error);
    assert.equal(f.app.agentdeckStore.pendingSessionIds.length, 0);
    assert.equal(f.app.sendPrompt('s1', 'Next task'), true);
    await tick();
    f.reply(f.requests.at(-1), { answer: 'Next answer' });
    await tick();
    assert.equal(f.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'Next answer');
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
  assert.match(f.app.agentdeckStore.errorsBySession.s1, /reset the app/i);
  f.app.hardResetApp();
  const fresh = documentFixture(f);
  await fresh.connect();
  await fresh.openSession();
  assert.equal(fresh.app.sendPrompt('s1', 'Recovered task'), true);
  await tick();
  fresh.reply(fresh.requests.at(-1), { answer: 'Recovered' });
  await tick();
  assert.equal(fresh.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('completed responses stay unread across list refreshes until read or a new prompt starts', async () => {
  const f = await running();
  assert.equal(f.app.agentdeckStore.unreadSessionIds.length, 0);
  f.reply(f.requests.at(-1), { answer: 'Done' });
  await tick();
  assert.ok(f.app.agentdeckStore.unreadSessionIds.includes('s1'));

  const refresh = f.app.refreshSessions();
  await f.settleHost();
  await refresh;
  assert.ok(f.app.agentdeckStore.unreadSessionIds.includes('s1'));

  f.app.setSessionFlag('unreadSessionIds', 's1', false);
  assert.equal(f.app.agentdeckStore.unreadSessionIds.length, 0);
  assert.equal(f.app.sendPrompt('s1', 'Next task'), true);
  await tick();
  f.reply(f.requests.at(-1), { answer: 'Next answer' });
  await tick();
  assert.ok(f.app.agentdeckStore.unreadSessionIds.includes('s1'));
  assert.equal(f.app.sendPrompt('s1', 'One more task'), true);
  assert.equal(f.app.agentdeckStore.unreadSessionIds.length, 0);
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
    assert.equal(f.app.agentdeckStore.pendingSessionIds.length, 0);
    assert.equal(f.app.agentdeckStore.unreadSessionIds.length, 0);
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
  assert.ok(f.app.agentdeckStore.unreadSessionIds.includes(session.sessionId));
  f.app.resetRemoteState();
  assert.equal(f.app.agentdeckStore.unreadSessionIds.length, 0);
});

test('pending permission requests expose active permission status for session list items', async () => {
  const f = await running();
  assert.equal(Object.keys(f.app.agentdeckStore.permissionsBySession).length, 0);
  f.deliver({
    id: 'permission',
    method: 'agent_permission_request',
    peerId: 1,
    params: {
      agent: 'codex',
      sessionId: 's1',
      options: [{ optionId: 'allow', name: 'Allow' }],
    },
  });
  await tick();
  assert.deepEqual(Object.keys(f.app.agentdeckStore.permissionsBySession), ['s1']);
  assert.equal(f.app.agentdeckStore.pendingSessionIds.includes('s1'), true);

  f.app.resolvePermission('s1', 'allow');
  await tick();
  assert.equal(Object.keys(f.app.agentdeckStore.permissionsBySession).length, 0);
  assert.equal(f.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
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

test('session list page supports pull to refresh via tap-page refreshable and @refresh', () => {
  const sessionListSource = readFileSync(path.join(root, 'src/pages/session-list.ts'), 'utf8');

  // Verify refreshSessions is imported
  assert.match(sessionListSource, /refreshSessions/);

  // Verify tap-page has refreshable and @refresh handler
  assert.match(sessionListSource, /<tap-page[\s\S]*?refreshable[\s\S]*?@refresh=\$\{this\.#onRefresh\}/);

  // Verify #onRefresh calls refreshSessions and ends refresh indicator
  assert.match(sessionListSource, /#onRefresh\s*=\s*async\s*\((?:event|evt)/);
  assert.match(sessionListSource, /await\s+refreshSessions\(\)/);
  assert.match(sessionListSource, /(?:event|evt)\.detail\?\.?\(\)/);
});

test('pull-to-refresh triggers session refresh and updates sessions in store', async () => {
  const f = documentFixture();
  await f.connect();
  const initialReqCount = f.requests.filter((r) => r.payload.method === 'agent_session_list').length;

  const refreshing = f.app.refreshSessions();
  await tick();
  const listRequests = f.requests.filter((r) => r.payload.method === 'agent_session_list');
  assert.equal(listRequests.length, initialReqCount + 1);

  f.reply(listRequests.at(-1), {
    sessions: [{ sessionId: 's2', title: 'Refreshed Session', cwd: '/workspace', updatedAt: '2026-09-23T00:00:00Z' }],
  });
  await refreshing;
  assert.ok(f.app.agentdeckStore.sessions.some((s) => s.sessionId === 's2'));
});
