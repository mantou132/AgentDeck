import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const deleteRequests = (fixture) =>
  fixture.requests.filter((request) => request.payload.method === 'agent_session_delete');

test('deletion waits for the host and removes the session, empty group, and cached state', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();
  f.app.setMessages('s1', [{ id: 'message', role: 'agent', text: 'Done' }]);
  f.app.setSessionFlag('unreadSessionIds', 's1', true);
  f.app.updateSessionOptions('s1', { configOptions: [] });
  f.app.setSessionError('s1', 'Old error');

  const deleting = f.app.deleteSession('s1');
  await tick();
  const request = deleteRequests(f).at(-1);
  assert.deepEqual(request.payload.params, { agent: 'codex', sessionId: 's1', timeoutSeconds: 60 });
  assert.ok(f.app.getSession('s1'));
  assert.ok(f.app.agentdeckStore.deletingSessionIds.includes('s1'));
  await f.app.deleteSession('s1');
  assert.equal(deleteRequests(f).length, 1);

  f.reply(request, { deleted: true });
  await deleting;
  const store = f.app.agentdeckStore;
  assert.equal(f.app.getSession('s1'), undefined);
  assert.equal(store.sessions.length, 0);
  assert.equal(store.sessionGroups.length, 0);
  assert.equal(store.messagesBySession.s1, undefined);
  assert.equal(store.errorsBySession.s1, undefined);
  assert.equal(store.optionsBySession.s1, undefined);
  assert.equal(store.loadedSessionIds.length, 0);
  assert.equal(store.unreadSessionIds.length, 0);
  assert.equal(store.deletingSessionIds.length, 0);
  assert.equal(f.app.isSessionOpened('s1'), false);
});

test('a failed deletion retains the session and can be retried', async () => {
  const f = documentFixture();
  await f.connect();
  const deleting = f.app.deleteSession('s1');
  await tick();
  f.deliver({ id: deleteRequests(f).at(-1).payload.id, peerId: 1, error: 'Session is busy' });
  await deleting;
  assert.ok(f.app.getSession('s1'));
  assert.equal(f.app.agentdeckStore.sessionsError, 'Session is busy');
  assert.equal(f.app.agentdeckStore.deletingSessionIds.length, 0);

  const retry = f.app.deleteSession('s1');
  await tick();
  assert.equal(f.app.agentdeckStore.sessionsError, '');
  f.reply(deleteRequests(f).at(-1), { deleted: true });
  await retry;
  assert.equal(f.app.getSession('s1'), undefined);
});

test('a timed out deletion preserves the item and offers list refresh recovery', async () => {
  const f = documentFixture();
  await f.connect();
  const deleting = f.app.deleteSession('s1');
  await f.advance(65_000);
  await deleting;
  assert.ok(f.app.getSession('s1'));
  assert.equal(f.app.agentdeckStore.deletingSessionIds.length, 0);
  assert.match(f.app.agentdeckStore.sessionsError, /reload the list/i);
});

test('a stale list response cannot bring back a deleted session', async () => {
  const f = documentFixture();
  await f.connect();
  const session = f.app.getSession('s1');
  const refreshing = f.app.refreshSessions();
  await tick();
  const list = f.requests.at(-1);
  const deleting = f.app.deleteSession('s1');
  await tick();
  f.reply(deleteRequests(f).at(-1), { deleted: true });
  await deleting;
  f.reply(list, { sessions: [session] });
  await refreshing;
  assert.equal(f.app.agentdeckStore.sessionsLoading, false);
  assert.equal(f.app.agentdeckStore.sessions.length, 0);
  assert.equal(f.app.agentdeckStore.sessionGroups.length, 0);
});

test('offline deletion sends no request and preserves the session', async () => {
  const f = documentFixture();
  await f.connect();
  f.app.agentdeckStore({ connection: 'disconnected' });
  await f.app.deleteSession('s1');
  assert.equal(deleteRequests(f).length, 0);
  assert.ok(f.app.getSession('s1'));
  assert.match(f.app.agentdeckStore.sessionsError, /not connected/i);
});
