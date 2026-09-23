import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

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

test('session page back button uses tap-gesture to recognize long press and close session', () => {
  const sessionSource = readFileSync(path.join(root, 'src/pages/session.ts'), 'utf8');

  // Verify closeSession is imported and called
  assert.match(sessionSource, /import\s*\{[^}]*closeSession[^}]*\}\s*from\s*'\.\.\/state\/sessions'/);
  assert.match(sessionSource, /closeSession\(this\.sessionId\)/);

  // Verify haptic impact is triggered on long press
  assert.match(sessionSource, /hapticImpact\('medium'\)/);

  // Verify Stack.pop is called on long press and standard click
  assert.match(sessionSource, /Stack\.pop\(\)/);

  // Verify tap-gesture component with role="button", @press and @click
  assert.match(
    sessionSource,
    /<tap-gesture[\s\S]*?role="button"[\s\S]*?@press=\$\{this\.#onBackPress\}[\s\S]*?@click=\$\{this\.#onBackClick\}/,
  );
});

test('translations contain session.backTitle for hint/tooltip', () => {
  const zh = JSON.parse(readFileSync(path.join(root, 'src/locales/zh-CN/basic.json'), 'utf8'));
  const en = JSON.parse(readFileSync(path.join(root, 'src/locales/en/basic.json'), 'utf8'));

  assert.equal(zh['session.backTitle'], '返回（长按关闭会话）');
  assert.equal(en['session.backTitle'], 'Back (Long press to close session)');
});
