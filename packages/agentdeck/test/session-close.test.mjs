import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const closeRequests = (fixture) =>
  fixture.requests.filter((request) => request.payload.method === 'agent_session_close');

test('closeSession closes the remote session actor and clears local open/pending/loaded flags while keeping the session in the list', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();

  // Set up active session state
  f.app.setMessages('s1', [{ id: 'm1', role: 'agent', text: 'Streaming...', streaming: true }]);
  f.app.setSessionFlag('pendingSessionIds', 's1', true);
  f.app.setSessionFlag('unreadSessionIds', 's1', true);
  f.app.setSessionError('s1', 'Temporary error');

  assert.equal(f.app.isSessionOpened('s1'), true);
  assert.equal(f.app.agentdeckStore.loadedSessionIds.includes('s1'), true);
  assert.equal(f.app.agentdeckStore.pendingSessionIds.includes('s1'), true);

  const initialCloseCount = closeRequests(f).length;

  // Close the session
  const closing = f.app.closeSession('s1');
  await tick();

  const req = closeRequests(f).at(-1);
  assert.equal(closeRequests(f).length, initialCloseCount + 1);
  assert.deepEqual(req.payload.params, { agent: 'codex', sessionId: 's1' });

  f.reply(req, { closed: true });
  await closing;

  const store = f.app.agentdeckStore;
  // Session is closed, NOT deleted: still exists in sessions
  assert.ok(f.app.getSession('s1'));
  assert.equal(
    store.sessions.some((s) => s.sessionId === 's1'),
    true,
  );

  // Active / open / loaded / pending flags are cleared
  assert.equal(f.app.isSessionOpened('s1'), false);
  assert.equal(store.loadedSessionIds.includes('s1'), false);
  assert.equal(store.loadingSessionIds.includes('s1'), false);
  assert.equal(store.pendingSessionIds.includes('s1'), false);
  assert.equal(store.unreadSessionIds.includes('s1'), false);
  assert.equal(store.errorsBySession.s1, undefined);

  // Streaming flag is finished
  assert.equal(store.messagesBySession.s1[0].streaming, false);
});

test('closeSession dismisses pending permissions with error', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();

  f.app.sendPrompt('s1', 'Perform action');
  await tick();

  f.deliver({
    id: 'perm-req-close',
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

  const closing = f.app.closeSession('s1');
  await f.settleHost();
  await closing;

  assert.equal(f.app.agentdeckStore.permissionsBySession.s1, undefined);
  const permReply = f.requests.find((r) => r.payload.id === 'perm-req-close');
  assert.ok(permReply);
  assert.ok(permReply.payload.error);
});

test('closeSession on a pending session cancels creation and resets pending state', async () => {
  const f = documentFixture();
  await f.connect();

  f.app.createPendingSession({ agent: 'codex', cwd: '/workspace' });
  assert.ok(f.app.getSession('pending-session'));
  assert.equal(f.app.agentdeckStore.pendingSession?.cwd, '/workspace');

  await f.app.closeSession('pending-session');
  assert.equal(f.app.getSession('pending-session'), undefined);
  assert.equal(f.app.agentdeckStore.pendingSession, null);
});

test('re-opening a closed session triggers fresh loadSession sequence', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();

  const closing = f.app.closeSession('s1');
  await f.settleHost();
  await closing;
  assert.equal(f.app.isSessionOpened('s1'), false);

  // Open again: since openedSessionIds is false, it executes full load sequence
  const loading = f.app.ensureSessionLoaded('s1');
  await f.settleHost();
  await loading;

  assert.equal(f.app.isSessionOpened('s1'), true);
  assert.equal(f.app.agentdeckStore.loadedSessionIds.includes('s1'), true);
});
