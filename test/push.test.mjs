import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const attaches = (fixture) => fixture.requests.filter(({ payload }) => payload.method === 'peer_attach');

test('push token travels inside the encrypted handshake, not the Relay routing fields', async () => {
  const { id } = JSON.parse(readFileSync(new URL('./fixtures/e2ee-v1.json', import.meta.url)));
  const f = documentFixture(undefined, { pairingId: id });
  f.transport.updateFcmToken('private-push-token');
  await f.connect();
  assert.equal(attaches(f)[0].payload.params.fcmToken, 'private-push-token');
  assert.equal(JSON.stringify(f.sockets[0].sent).includes('private-push-token'), false);
  assert.equal(f.sockets[0].url.includes('private-push-token'), false);
});

test('a token arriving during initial attach is synchronized after the handshake', async () => {
  const f = documentFixture();
  f.heldMethods.add('peer_attach');
  await f.connect();
  assert.equal(attaches(f).length, 1);
  assert.equal(attaches(f)[0].payload.params.fcmToken, undefined);
  f.transport.updateFcmToken('first-token');
  await tick();
  assert.equal(attaches(f).length, 1, 'do not overlap attach requests');
  f.heldMethods.clear();
  await f.settleHost();
  assert.equal(attaches(f).length, 2);
  assert.equal(attaches(f)[1].payload.params.fcmToken, 'first-token');
  assert.equal(f.app.agentdeckStore.connection, 'connected');
});

test('token refresh preserves a live prompt, allows RPCs and coalesces concurrent refreshes', async () => {
  const f = documentFixture();
  f.transport.updateFcmToken('initial');
  await f.connect();
  await f.openSession();
  f.app.sendPrompt('s1', 'long task');
  await tick();
  const prompt = f.requests.find(({ payload }) => payload.method === 'agent_prompt');
  f.heldMethods.add('peer_attach');
  f.transport.updateFcmToken('second');
  await tick();
  f.transport.updateFcmToken('latest');
  await tick();
  assert.equal(attaches(f).length, 2);
  assert.equal(f.app.agentdeckStore.connection, 'connected');
  const listing = f.transport.agentApi.listSessions('codex');
  await f.settleHost();
  await listing;
  f.reply(prompt, { answer: 'done' });
  await tick();
  assert.equal(f.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'done');
  assert.equal(f.app.agentdeckStore.pendingSessionIds.length, 0);
  f.heldMethods.clear();
  await f.settleHost();
  assert.deepEqual(
    attaches(f).map(({ payload }) => payload.params.fcmToken),
    ['initial', 'second', 'latest'],
  );
  f.transport.updateFcmToken('latest');
  await f.settleHost();
  assert.equal(attaches(f).length, 3, 'unchanged tokens do not cause another RPC');
});

test('registration timeout preserves connection and can be retried with the same token', async () => {
  const f = documentFixture();
  await f.connect();
  f.heldMethods.add('peer_attach');
  f.transport.updateFcmToken('retry-token');
  await tick();
  await f.advance(10_000);
  assert.equal(f.app.agentdeckStore.connection, 'connected');
  f.heldMethods.clear();
  f.transport.updateFcmToken('retry-token');
  await f.settleHost();
  assert.equal(attaches(f).length, 3);
  assert.equal(f.app.agentdeckStore.connection, 'connected');
});

test('reconnect resends the current token and permission revocation sends explicit null', async () => {
  const f = documentFixture();
  f.transport.updateFcmToken('current');
  await f.connect();
  f.transport.reconnectTransport(true);
  await tick();
  f.sockets.at(-1).open();
  await f.settleHost();
  assert.equal(attaches(f).at(-1).payload.params.fcmToken, 'current');
  f.transport.updateFcmToken(null);
  await f.settleHost();
  assert.equal(attaches(f).at(-1).payload.params.fcmToken, null);
  assert.equal(f.app.agentdeckStore.connection, 'connected');
});
