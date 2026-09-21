import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, relayKey, tick } from './helpers/app-fixture.mjs';

const outbox = (fixture) => JSON.parse(fixture.localStorage.getItem(relayKey)).outbox;

test('foreground and online keep a live connection; manual reconnect preserves prompt replies', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'long task');
  await tick();
  const prompt = fixture.requests.find((request) => request.payload.method === 'agent_prompt');
  fixture.sockets.at(-1).frame({ type: 'stored', message_id: prompt.message_id });
  await tick();
  const socket = fixture.sockets.at(-1);
  fixture.window.dispatchEvent(new Event('online'));
  fixture.document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(fixture.sockets.length, 1);
  assert.equal(socket.readyState, socket.constructor.OPEN);
  assert.equal(fixture.app.agentdeckStore.connection, 'connected');

  fixture.transport.reconnectTransport(true);
  await tick();
  assert.equal(new URL(fixture.sockets.at(-1).url).searchParams.has('ack_head'), false);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  fixture.deliver({
    id: prompt.payload.id,
    event: {
      event: 'session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'missed response' },
      },
    },
    peerId: 1,
  });
  fixture.reply(prompt, { answer: 'missed response' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.includes('s1'), false);
  assert.equal(fixture.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'missed response');
  assert.equal(fixture.requests.filter((request) => request.payload.method === 'agent_prompt').length, 1);
});

test('automatic SDK reconnect also keeps the receive cursor and unacknowledged request ID', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'task');
  await tick();
  const prompt = fixture.requests.at(-1);
  const cursor = JSON.parse(fixture.localStorage.getItem(relayKey)).lastReceived;
  fixture.sockets.at(-1).close();
  await fixture.advance(1000);
  const socket = fixture.sockets.at(-1);
  assert.equal(new URL(socket.url).searchParams.has('ack_head'), false);
  assert.equal(JSON.parse(fixture.localStorage.getItem(relayKey)).lastReceived, cursor);
  socket.open();
  await fixture.settleHost();
  const replay = socket.sent.find((frame) => frame.payload?.method === 'agent_prompt');
  assert.equal(replay.message_id, prompt.message_id);
  fixture.reply(prompt, { answer: 'done' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('Relay ready does not enable App until host attach succeeds; timeout can be retried', async () => {
  const fixture = documentFixture();
  fixture.heldMethods.add('peer_attach');
  await fixture.connect();
  assert.equal(fixture.app.agentdeckStore.connection, 'attaching');
  assert.equal(
    fixture.requests.some((request) => request.payload.method === 'agent_list'),
    false,
  );
  await fixture.advance(10_000);
  assert.equal(fixture.app.agentdeckStore.connection, 'unavailable');
  assert.match(fixture.app.agentdeckStore.connectionError, /Connecting to host timed out/);
  assert.equal(outbox(fixture).length, 0, 'expired unacknowledged attach is withdrawn');
  fixture.heldMethods.clear();
  await fixture.app.refreshSessions();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  assert.equal(fixture.app.agentdeckStore.connection, 'connected');
  assert.equal(fixture.app.agentdeckStore.sessions.length, 1);
});

test('Relay handshake watchdog recovers a socket stuck before ready', async () => {
  const fixture = documentFixture();
  fixture.app.startApp();
  await fixture.advance(10_000);
  assert.match(fixture.app.agentdeckStore.connectionError, /Connecting to Relay timed out/);
  assert.equal(fixture.sockets[0].readyState, 3);
  await fixture.advance(3000);
  assert.equal(fixture.sockets.length, 2);
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  assert.equal(fixture.app.agentdeckStore.connection, 'connected');
});

test('offline session load error and retry survive a successful reconnection', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  fixture.sockets.at(-1).close();
  await fixture.app.ensureSessionLoaded('s1');
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /Host is not connected/);
  fixture.app.retrySessionLoad('s1');
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  assert.equal(fixture.app.agentdeckStore.connection, 'connected');
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /Host is not connected/);
  const retry = fixture.app.retrySessionLoad('s1');
  await fixture.settleHost();
  await retry;
  assert.equal(fixture.app.isSessionOpened('s1'), true);
  assert.equal(fixture.app.agentdeckStore.errorsBySession.s1, '');
});

test('a timed-out close does not proceed to load; a timed-out load can be retried', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  fixture.heldMethods.add('agent_session_close');
  const first = fixture.app.ensureSessionLoaded('s1');
  await fixture.settleHost();
  await fixture.advance(10_000);
  await first;
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /Closing session timed out/);
  assert.equal(
    fixture.requests.some((request) => request.payload.method === 'agent_session_load'),
    false,
  );
  fixture.heldMethods.delete('agent_session_close');
  fixture.heldMethods.add('agent_session_load');
  const second = fixture.app.retrySessionLoad('s1');
  await fixture.settleHost();
  const oldLoad = fixture.requests.find((request) => request.payload.method === 'agent_session_load');
  await fixture.advance(65_000);
  await second;
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /Loading session timed out/);
  assert.equal(fixture.app.agentdeckStore.loadingSessionIds.length, 0);
  assert.equal(
    outbox(fixture).some((request) => request.payload.id === oldLoad.payload.id),
    false,
  );
  fixture.heldMethods.delete('agent_session_load');
  const third = fixture.app.retrySessionLoad('s1');
  fixture.reply(oldLoad, { sessionId: 'stale' });
  await fixture.settleHost();
  await third;
  assert.equal(fixture.app.isSessionOpened('s1'), true);
});

test('directory and session-list requests end at their deadlines, but prompt has no short deadline', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  const cwd = fixture.app.agentApi.browseFiles('');
  const cwdRejected = assert.rejects(cwd, /Reading directory timed out/);
  await fixture.advance(15_000);
  await cwdRejected;
  fixture.heldMethods.add('agent_session_list');
  const list = fixture.app.refreshSessions();
  await fixture.settleHost();
  await fixture.advance(65_000);
  await list;
  assert.equal(fixture.app.agentdeckStore.sessionsLoading, false);
  assert.match(fixture.app.agentdeckStore.sessionsError, /Reading session list timed out/);
  fixture.app.sendPrompt('s1', 'long task');
  await tick();
  await fixture.advance(120_000);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
});

test('RPC settles asynchronous send failures and clears timers on completion/rejectAll', async () => {
  const fixture = documentFixture();
  const { RpcPeer } = fixture.rpc;
  const options = { timeoutMs: 10, timeoutMessage: 'timeout' };
  const failed = new RpcPeer(async () => {
    throw new Error('enqueue failed');
  });
  await assert.rejects(failed.call('test', {}, undefined, options), /enqueue failed/);
  assert.equal(fixture.timers.size, 0);
  const sent = [];
  const peer = new RpcPeer((message) => {
    sent.push(message);
  });
  const done = peer.call('test', {}, undefined, options);
  peer.dispatch({ id: sent[0].id, result: true });
  assert.equal(await done, true);
  assert.equal(fixture.timers.size, 0);
  const pending = peer.call('test', {}, undefined, options);
  const rejected = assert.rejects(pending, /reset/);
  peer.rejectAll(new Error('reset'));
  await rejected;
  assert.equal(fixture.timers.size, 0);
});

test('new attach may update peer ID and late replies cannot overwrite it', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  fixture.heldMethods.add('peer_attach');
  fixture.transport.reconnectTransport(true);
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  const oldAttach = fixture.requests.at(-1);
  fixture.transport.reconnectTransport(true);
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  const attach = fixture.requests.at(-1);
  fixture.deliver({ id: attach.payload.id, result: { peerId: 7 }, peerId: 7 });
  await tick();
  assert.equal(fixture.transport.getPeerId(), 7);
  fixture.deliver({ id: oldAttach.payload.id, result: { peerId: 1 }, peerId: 1 });
  await tick();
  assert.equal(fixture.transport.getPeerId(), 7);
});

test('another peer cannot end our session after attach completes', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.deliver({ method: 'agent_session_ended', params: { agent: 'codex', sessionId: 's1' }, peerId: 2 });
  await tick();
  assert.equal(fixture.app.isSessionOpened('s1'), true);
  fixture.deliver({ method: 'agent_session_ended', params: { agent: 'codex', sessionId: 's1' }, peerId: 1 });
  await tick();
  assert.equal(fixture.app.isSessionOpened('s1'), false);
});

test('a disposed client cannot advance the cursor or reconnect under a new pairing', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  const oldSocket = fixture.sockets.at(-1);
  oldSocket.frame({ type: 'message', sequence: 9999, message_id: 'old', payload: { method: 'host_reconnected' } });
  fixture.app.saveSettings({ relayId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', agent: 'codex' });
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  assert.equal(JSON.parse(fixture.localStorage.getItem(relayKey)).relayId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.notEqual(JSON.parse(fixture.localStorage.getItem(relayKey)).lastReceived, 9999);
  const socketCount = fixture.sockets.length;
  await fixture.advance(12_000);
  assert.equal(fixture.sockets.length, socketCount);
});
