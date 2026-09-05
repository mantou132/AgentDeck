import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceKey, documentFixture, relayId, relayKey, resetKey, settingsKey, tick } from './helpers/app-fixture.mjs';

for (const operation of ['loading', 'creating', 'prompt', 'permission']) {
  test(`reset during ${operation} reloads a clean App that can close/load and prompt again`, async () => {
    const old = documentFixture();
    await old.connect();
    if (operation === 'loading') {
      old.heldMethods.add('agent_session_load');
      void old.app.ensureSessionLoaded('s1');
      await old.settleHost();
      assert.equal(old.app.agentdeckStore.loadingSessionIds.includes('s1'), true);
    } else if (operation === 'creating') {
      old.heldMethods.add('agent_session_create');
      const draft = old.app.createDraftSession({ agent: 'codex', cwd: '/tmp' });
      void old.app.promoteDraftSession(draft, 'old draft');
      await tick();
      assert.equal(old.app.agentdeckStore.pendingSessionIds.includes('draft'), true);
    } else {
      await old.openSession();
      old.app.sendPrompt('s1', 'old task');
      await tick();
      if (operation === 'permission') {
        old.deliver({
          id: 'old-permission',
          method: 'agent_permission_request',
          params: { agent: 'codex', sessionId: 's1', options: [{ optionId: 'allow', name: 'Allow' }] },
          peerId: 1,
        });
        await tick();
        assert.ok(old.app.agentdeckStore.permissionsBySession.s1);
      }
    }
    const staleRequest = old.requests.at(-1);
    const device = old.localStorage.getItem(deviceKey);
    const settings = old.localStorage.getItem(settingsKey);
    const requestCount = old.requests.length;
    old.app.hardResetApp();
    assert.equal(old.reloads, 1);
    assert.equal(old.sessionStorage.getItem(resetKey), 'true');
    assert.equal(old.requests.length, requestCount, 'reset does not await or send a remote close/cancel');

    // The old document can still write storage before navigation commits.
    // Cleanup must run in the new document, not before reload.
    old.localStorage.setItem(
      relayKey,
      JSON.stringify({ relayId, lastReceived: 9999, outbox: [{ messageId: 'stale', payload: staleRequest.payload }] }),
    );
    const fresh = documentFixture(old);
    await fresh.connect();
    assert.equal(fresh.sessionStorage.getItem(resetKey), null);
    assert.equal(fresh.localStorage.getItem(deviceKey), device);
    assert.equal(fresh.localStorage.getItem(settingsKey), settings);
    assert.equal(fresh.localStorage.getItem('unrelated.preference'), 'keep');
    assert.equal(new URL(fresh.sockets[0].url).searchParams.get('ack_head'), 'true');
    assert.equal(fresh.app.agentdeckStore.sessionsLoaded, true);
    assert.equal(fresh.app.agentdeckStore.pendingSessionIds.length, 0);
    assert.equal(fresh.app.agentdeckStore.loadingSessionIds.length, 0);
    assert.equal(Object.keys(fresh.app.agentdeckStore.permissionsBySession).length, 0);
    assert.equal(fresh.app.agentdeckStore.draftSession, null);
    assert.equal(
      fresh.requests.some((request) => request.message_id === 'stale'),
      false,
    );

    // A live old host may still emit replies and permission requests after reset.
    fresh.reply(staleRequest, { answer: 'old answer', sessionId: 'old-created' });
    fresh.deliver({
      id: 'late-permission',
      method: 'agent_permission_request',
      params: { agent: 'codex', sessionId: 's1' },
      peerId: 1,
    });
    await tick();
    assert.equal(Object.keys(fresh.app.agentdeckStore.messagesBySession).length, 0);
    assert.equal(Object.keys(fresh.app.agentdeckStore.permissionsBySession).length, 0);
    assert.ok(fresh.requests.find((request) => request.payload.id === 'late-permission')?.payload.error);

    await fresh.openSession();
    const methods = fresh.requests.map((request) => request.payload.method);
    assert.ok(methods.indexOf('agent_session_close') < methods.indexOf('agent_session_load'));
    assert.equal(fresh.app.sendPrompt('s1', 'new task'), true);
    await tick();
    const newPrompt = fresh.requests.find((request) => request.payload.method === 'agent_prompt');
    assert.notEqual(newPrompt.payload.id, staleRequest.payload.id);
    fresh.reply(staleRequest, { answer: 'another old answer' });
    await tick();
    assert.equal(fresh.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
    fresh.reply(newPrompt, { answer: 'new answer' });
    await tick();
    assert.equal(fresh.app.agentdeckStore.pendingSessionIds.length, 0);
    assert.equal(fresh.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'new answer');
    assert.equal(fresh.app.agentdeckStore.errorsBySession.s1, '');
  });
}

test('reset remains available while offline and across repeated reloads', () => {
  let current = documentFixture();
  for (let i = 0; i < 3; i++) {
    current.app.startApp();
    assert.equal(current.app.agentdeckStore.connection, 'connecting');
    current.app.hardResetApp();
    assert.equal(current.reloads, 1);
    current = documentFixture(current);
  }
});

test('failure to mark a reset is surfaced before navigation', () => {
  const app = documentFixture();
  app.sessionStorage.setItem = () => {
    throw new Error('Storage unavailable');
  };
  assert.throws(() => app.app.hardResetApp(), /Storage unavailable/);
  assert.equal(app.reloads, 0);
});

test('failed cleanup keeps the reset marker and does not replay the old outbox', async () => {
  const failed = documentFixture();
  failed.app.hardResetApp();
  failed.localStorage.setItem(relayKey, 'old queue');
  const remove = failed.localStorage.removeItem;
  failed.localStorage.removeItem = () => {
    throw new Error('Storage unavailable');
  };
  const boot = documentFixture(failed);
  boot.app.startApp();
  assert.equal(boot.sockets.length, 0);
  assert.match(boot.app.agentdeckStore.sessionsError, /重置本地连接失败/);
  assert.equal(boot.sessionStorage.getItem(resetKey), 'true');
  boot.localStorage.removeItem = remove;
  boot.app.hardResetApp();
  const recovered = documentFixture(boot);
  await recovered.connect();
  assert.equal(recovered.app.agentdeckStore.sessionsLoaded, true);
  assert.equal(recovered.sessionStorage.getItem(resetKey), null);
});

test('ordinary startup keeps the Relay store when no reset was requested', async () => {
  const fixture = documentFixture();
  fixture.localStorage.setItem(relayKey, JSON.stringify({ relayId, lastReceived: 12, outbox: [] }));
  fixture.app.startApp();
  await tick();
  assert.equal(JSON.parse(fixture.localStorage.getItem(relayKey)).lastReceived, 12);
});
