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
  f.app.updateRuntime('s1', { turn: {}, unread: true, error: 'Temporary error' });

  assert.equal(f.app.isSessionOpened('s1'), true);
  assert.equal(f.app.isTurnRunning('s1'), true);

  const initialCloseCount = closeRequests(f).length;

  // Close the session
  const closing = f.app.closeSession('s1');
  await tick();

  const req = closeRequests(f).at(-1);
  assert.equal(closeRequests(f).length, initialCloseCount + 1);
  assert.deepEqual(req.payload.params, { agent: 'codex', sessionId: 's1' });

  f.reply(req, { closed: true });
  await closing;

  // Session is closed, NOT deleted: still exists in sessions
  assert.ok(f.app.getSession('s1'));
  assert.equal(
    f.app.sessionsStore.sessions.some((s) => s.sessionId === 's1'),
    true,
  );

  // Active / open / loaded / pending flags are cleared
  assert.equal(f.app.getRuntime('s1').load, 'idle');
  assert.equal(f.app.isTurnRunning('s1'), false);
  assert.equal(Boolean(f.app.getRuntime('s1').unread), false);
  assert.equal(f.app.getRuntime('s1').error, '');

  // Streaming flag is finished
  assert.equal(f.app.getMessages('s1')[0].streaming, false);
});

test('closeSession dismisses pending permissions with error', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();

  f.app.sendPrompt('s1', 'Perform action');
  await tick();

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

  const closing = f.app.closeSession('s1');
  await f.settleHost();
  await closing;

  assert.equal(f.app.getRuntime('s1').permission, undefined);
  // The host cancels the request when the session closes; nothing is answered.
  assert.equal(
    f.requests.find((r) => r.payload.method === 'agent_user_input_respond'),
    undefined,
  );
});

test('closeSession on a pending session cancels creation and resets pending state', async () => {
  const f = documentFixture();
  await f.connect();

  const { sessionId } = f.app.createPendingSession({ agent: 'codex', cwd: '/workspace' });
  assert.equal(f.app.getSession(sessionId)?.cwd, '/workspace');

  await f.app.closeSession(sessionId);
  assert.equal(f.app.getSession(sessionId), undefined);
  assert.equal(f.app.sessionsStore.runtimes[sessionId], undefined);
});

test('re-opening a closed session triggers fresh loadSession sequence', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();

  const closing = f.app.closeSession('s1');
  await f.settleHost();
  await closing;
  assert.equal(f.app.isSessionOpened('s1'), false);

  // Open again: the closed session is no longer loaded, so it runs the full load sequence
  const loading = f.app.ensureSessionLoaded('s1');
  await f.settleHost();
  await loading;

  assert.equal(f.app.isSessionOpened('s1'), true);
});
