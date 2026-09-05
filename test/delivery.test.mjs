import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, relayKey, tick } from './helpers/app-fixture.mjs';

const outbox = (fixture) => JSON.parse(fixture.localStorage.getItem(relayKey)).outbox;
const reject = async (fixture, request, reason = 'queue_full: pending message count limit reached') => {
  fixture.sockets.at(-1).frame({ type: 'rejected', message_id: request.message_id, reason });
  await tick();
};

test('rejected prompt settles only its call, is not replayed, and can be retried', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'first attempt');
  const cwd = fixture.app.agentApi.completeCwd('/tmp');
  await tick();
  const prompt = fixture.requests.find((request) => request.payload.method === 'agent_prompt');
  const directory = fixture.requests.at(-1);
  await reject(fixture, prompt);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /队列已满/);
  assert.equal(
    outbox(fixture).some((message) => message.messageId === prompt.message_id),
    false,
  );
  fixture.reply(directory, { value: '/tmp', isDirectory: true, directories: [] });
  assert.equal((await cwd).isDirectory, true);

  fixture.transport.reconnectTransport(true);
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  assert.equal(fixture.requests.filter((request) => request.message_id === prompt.message_id).length, 1);
  assert.equal(fixture.app.sendPrompt('s1', 'retry'), true);
  await tick();
  const retry = fixture.requests.at(-1);
  assert.notEqual(retry.message_id, prompt.message_id);
  await reject(fixture, prompt);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
  fixture.reply(retry, { answer: 'done' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.equal(fixture.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'done');
});

test('rejected handshake can reconnect without waiting for its deadline', async () => {
  const fixture = documentFixture();
  fixture.heldMethods.add('peer_attach');
  await fixture.connect();
  await reject(fixture, fixture.requests.at(-1));
  assert.equal(fixture.app.agentdeckStore.connection, 'unavailable');
  assert.match(fixture.app.agentdeckStore.connectionError, /队列已满/);
  assert.equal(outbox(fixture).length, 0);
  fixture.heldMethods.clear();
  await fixture.app.refreshSessions();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  assert.equal(fixture.app.agentdeckStore.connection, 'connected');
});

test('rejected session list and draft creation both leave a usable retry path', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  fixture.heldMethods.add('agent_session_list');
  const refresh = fixture.app.refreshSessions();
  await fixture.settleHost();
  const list = fixture.requests.findLast((request) => request.payload.method === 'agent_session_list');
  await reject(fixture, list, 'database temporarily unavailable');
  await refresh;
  assert.equal(fixture.app.agentdeckStore.sessionsLoading, false);
  assert.match(fixture.app.agentdeckStore.sessionsError, /Relay 拒绝/);
  fixture.heldMethods.clear();
  const retry = fixture.app.refreshSessions();
  await fixture.settleHost();
  await retry;
  assert.equal(fixture.app.agentdeckStore.sessionsError, '');

  fixture.heldMethods.add('agent_session_create');
  const draft = fixture.app.createDraftSession({ agent: 'codex', cwd: '/tmp' });
  const creation = fixture.app.promoteDraftSession(draft, 'draft task');
  await tick();
  await reject(fixture, fixture.requests.at(-1));
  assert.equal(await creation, null);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.ok(fixture.app.agentdeckStore.draftSession);
  assert.match(fixture.app.agentdeckStore.errorsBySession.draft, /队列已满/);
  fixture.heldMethods.clear();
  const created = fixture.app.promoteDraftSession(draft, 'draft task');
  await fixture.settleHost();
  assert.equal((await created).sessionId, 'created');
  const prompt = fixture.requests.at(-1);
  fixture.reply(prompt, { answer: 'created and sent' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('oversized UTF-8 frames fail before enqueue or send and a smaller prompt works', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  const requestCount = fixture.requests.length;
  fixture.app.sendPrompt('s1', '汉'.repeat(Math.ceil((10 * 1024 * 1024) / 3)));
  await tick();
  assert.equal(fixture.requests.length, requestCount);
  assert.equal(outbox(fixture).length, 0);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /消息过大，未发送/);
  assert.equal(fixture.app.sendPrompt('s1', 'smaller prompt'), true);
  await tick();
  fixture.reply(fixture.requests.at(-1), { answer: 'done' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('local storage failure does not silently strand a prompt', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  const save = fixture.localStorage.setItem;
  const requestCount = fixture.requests.length;
  fixture.localStorage.setItem = (key, value) => {
    if (key === relayKey) throw new Error('Quota exceeded');
    save(key, value);
  };
  fixture.app.sendPrompt('s1', 'cannot persist');
  await tick();
  assert.equal(fixture.requests.length, requestCount);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /无法保存待发送消息/);
  fixture.localStorage.setItem = save;
  assert.equal(fixture.app.sendPrompt('s1', 'retry'), true);
  await tick();
  fixture.reply(fixture.requests.at(-1), { answer: 'done' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('WebSocket send failure reaches the prompt and removes its queued message', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  const socket = fixture.sockets.at(-1);
  const send = socket.send.bind(socket);
  socket.send = () => {
    throw new Error('Socket send failed');
  };
  fixture.app.sendPrompt('s1', 'cannot send');
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /Socket send failed/);
  assert.equal(outbox(fixture).length, 0);
  socket.send = send;
  assert.equal(fixture.app.sendPrompt('s1', 'retry'), true);
  await tick();
  fixture.reply(fixture.requests.at(-1), { answer: 'done' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('rejected permission reply is visible and reset restores the normal session flow', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'needs permission');
  await tick();
  fixture.deliver({
    id: 'permission',
    method: 'agent_permission_request',
    params: { agent: 'codex', sessionId: 's1', options: [{ optionId: 'allow', name: 'Allow' }] },
    peerId: 1,
  });
  await tick();
  fixture.app.resolvePermission('s1', 'allow');
  await tick();
  const reply = fixture.requests.find((request) => request.payload.id === 'permission');
  await reject(fixture, reply);
  assert.match(fixture.app.agentdeckStore.connectionError, /回复未能送达远端/);
  assert.equal(
    outbox(fixture).some((message) => message.messageId === reply.message_id),
    false,
  );
  fixture.app.hardResetApp();
  const fresh = documentFixture(fixture);
  await fresh.connect();
  await fresh.openSession();
  assert.equal(fresh.app.sendPrompt('s1', 'new task'), true);
  await tick();
  fresh.reply(fresh.requests.at(-1), { answer: 'recovered' });
  await tick();
  assert.equal(fresh.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('late rejection after stored or pairing change cannot fail another call', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'already accepted');
  await tick();
  const prompt = fixture.requests.at(-1);
  fixture.sockets.at(-1).frame({ type: 'stored', message_id: prompt.message_id });
  await tick();
  await reject(fixture, prompt);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
  assert.equal(fixture.app.agentdeckStore.errorsBySession.s1, '');
  fixture.reply(prompt, { answer: 'done' });
  await tick();
  const oldSocket = fixture.sockets.at(-1);
  const cwd = fixture.app.agentApi.completeCwd('/tmp');
  const closed = assert.rejects(cwd, /连接已关闭/);
  await tick();
  oldSocket.frame({ type: 'rejected', message_id: fixture.requests.at(-1).message_id, reason: 'queue_full:' });
  fixture.app.saveSettings({ relayId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', agent: 'codex' });
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  await closed;
  assert.equal(fixture.app.agentdeckStore.connection, 'connected');
  assert.equal(fixture.app.agentdeckStore.connectionError, '');
});
