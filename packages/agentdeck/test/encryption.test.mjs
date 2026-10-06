import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { documentFixture, relayKey, tick } from './helpers/app-fixture.mjs';

const vector = JSON.parse(readFileSync(new URL('./fixtures/e2ee-v1.json', import.meta.url)));
const { RelayEncryption, isPairingId } = documentFixture().encryption;

test('ID version, alphabet, and key length are checked without silently downgrading encryption', () => {
  assert.ok(isPairingId('01234567-89ab-cdef-0123-456789abcdef'));
  assert.ok(isPairingId(vector.id));
  for (const id of [
    'secret',
    `adk2_${vector.id.slice(5)}`,
    `${vector.id}=`,
    vector.id.slice(0, -1),
    `adk1_${'A'.repeat(42)}!`,
  ]) {
    assert.equal(isPairingId(id), false, id);
  }
});

test('both directions match the Rust interoperability fixture and reject tampering/reflection', () => {
  const app = new RelayEncryption(vector.id, 'app', 'test-phone');
  const host = new RelayEncryption(vector.id, 'host', 'host');
  assert.equal(app.routeId, vector.routeId);
  assert.deepEqual(JSON.parse(JSON.stringify(app.open(vector.hostFrame).message)), vector.hostMessage);
  assert.deepEqual(JSON.parse(JSON.stringify(host.open(vector.appFrame).message)), vector.appMessage);
  assert.throws(() => app.open(vector.appFrame));
  assert.throws(() => app.open({ method: 'host_reconnected', params: {} }));
  for (const [field, value] of [
    ['sender', 'other'],
    ['e2ee', 2],
    ['nonce', 'A'.repeat(32)],
    ['ciphertext', 'AAAA'],
  ]) {
    assert.throws(
      () => new RelayEncryption(vector.id, 'app', 'test-phone').open({ ...vector.hostFrame, [field]: value }),
      field,
    );
  }
  const wrong = new RelayEncryption(`adk1_${Buffer.alloc(32, 42).toString('base64url')}`, 'app', 'test-phone');
  assert.throws(() => wrong.open(vector.hostFrame));
});

test('encryption handles independent senders and large attachments without message state', () => {
  const receiver = new RelayEncryption(vector.id, 'host', 'host');
  const a = new RelayEncryption(vector.id, 'app', 'phone-a');
  const b = new RelayEncryption(vector.id, 'app', 'phone-b');
  const first = a.seal({ method: 'a', text: '附件'.repeat(40000) });
  assert.equal(receiver.open(first).message.text.length, 80000);
  assert.equal(receiver.open(b.seal({ method: 'b' })).sender, 'phone-b');
  assert.equal(receiver.open(first).message.text.length, 80000);
  assert.equal(new RelayEncryption(vector.id, 'host', 'host').open(first).message.text.length, 80000);
  assert.equal(Object.hasOwn(first, 'sequence'), false);
  assert.notEqual(a.seal({ method: 'a', text: '附件'.repeat(40000) }).nonce, first.nonce);
  const untrusted = { ...a.seal({ method: 'valid' }), sender: 'other-phone' };
  assert.throws(() => receiver.open(untrusted));
  assert.equal(receiver.open(a.seal({ method: 'still valid' })).message.method, 'still valid');
});

test('creating and using encryption does not read or write localStorage', () => {
  const fixture = documentFixture(undefined, { pairingId: vector.id });
  fixture.localStorage.getItem = fixture.localStorage.setItem = () => {
    throw new Error('Encryption must not access storage');
  };
  const codec = fixture.encryption.createRelayEncryption(vector.id, 'test-phone');
  const host = new RelayEncryption(vector.id, 'host', 'host');
  assert.equal(host.open(codec.seal({ text: 'hello' })).message.text, 'hello');
  assert.deepEqual(JSON.parse(JSON.stringify(codec.open(vector.hostFrame).message)), vector.hostMessage);
});

test('encrypted app handshake, prompt, streaming and retry keep plaintext off the wire/outbox', async () => {
  const fixture = documentFixture(undefined, { pairingId: vector.id });
  await fixture.connect();
  await fixture.openSession();
  assert.equal(fixture.app.agentdeckStore.connection, 'connected');
  assert.equal(new URL(fixture.sockets.at(-1).url).searchParams.get('id'), vector.routeId);
  assert.ok(!fixture.sockets.at(-1).url.includes(vector.id));
  fixture.app.sendPrompt('s1', 'secret prompt');
  await tick();
  const request = fixture.requests.at(-1);
  const wire = fixture.sockets.at(-1).sent.find((f) => f.message_id === request.message_id);
  assert.equal(wire.payload.e2ee, 1);
  assert.ok(!JSON.stringify(wire).includes('secret prompt'));
  const outbox = fixture.localStorage.getItem(relayKey);
  assert.ok(!outbox.includes('secret prompt'));
  assert.ok(!outbox.includes(vector.id));
  fixture.transport.reconnectTransport(true);
  await tick();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  const replay = fixture.sockets.at(-1).sent.find((f) => f.message_id === request.message_id);
  assert.deepEqual(replay, wire);
  fixture.deliver({
    id: request.payload.id,
    event: {
      event: 'session_update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'secret reply' } },
    },
    peerId: 1,
  });
  fixture.reply(request, { answer: 'secret reply' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'secret reply');
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('encrypted request expiry and Relay rejection still correlate with the RPC', async () => {
  const fixture = documentFixture(undefined, { pairingId: vector.id });
  fixture.heldMethods.add('peer_attach');
  await fixture.connect();
  await fixture.advance(10_000);
  assert.equal(JSON.parse(fixture.localStorage.getItem(relayKey)).outbox.length, 0);
  fixture.heldMethods.clear();
  fixture.transport.reconnectTransport(true);
  await tick();
  fixture.sockets.at(-1).open();
  await fixture.settleHost();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'rejected');
  await tick();
  fixture.sockets
    .at(-1)
    .frame({ type: 'rejected', message_id: fixture.requests.at(-1).message_id, reason: 'queue_full: test' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /queue is full/i);
});

test('encrypted attachments, file reads and permission decisions use the same protected transport', async () => {
  const fixture = documentFixture(undefined, { pairingId: vector.id });
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'review', [{ id: 'notes', kind: 'text', name: 'secret.md', text: 'private document' }]);
  await tick();
  const prompt = fixture.requests.at(-1);
  assert.match(prompt.payload.params.attachments[0].text, /private document/);
  fixture.deliver({
    method: 'agent_permission_request',
    params: { agent: 'codex', sessionId: 's1', requestId: 'p1', options: [{ optionId: 'allow', name: 'Allow' }] },
    peerId: 1,
  });
  await tick();
  fixture.app.resolvePermission('s1', 'allow');
  await tick();
  const answer = fixture.requests.find((request) => request.payload.method === 'agent_user_input_respond');
  assert.equal(answer.payload.params.response.optionId, 'allow');
  fixture.reply(answer, {});
  const file = fixture.app.agentApi.readFile('/tmp/secret.md', '/tmp');
  await tick();
  fixture.reply(fixture.requests.at(-1), { type: 'text', text: 'private file' });
  assert.equal((await file).text, 'private file');
  for (const frame of fixture.sockets.at(-1).sent.filter((frame) => frame.type === 'message')) {
    assert.equal(frame.payload.e2ee, 1);
    assert.ok(!/private document|secret\.md|optionId/.test(JSON.stringify(frame)));
  }
  fixture.reply(prompt, { answer: 'done' });
  await tick();
});

test('binary frames match the Rust vector and never open as JSON envelopes', () => {
  const app = new RelayEncryption(vector.id, 'app', 'test-phone');
  const frame = new Uint8Array(Buffer.from(vector.hostBinaryFrame, 'base64url'));
  assert.deepEqual(Buffer.from(app.openBytes(frame)), Buffer.from(vector.hostBinaryPlaintext, 'base64url'));
  const tampered = frame.slice();
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => app.openBytes(tampered));
  const envelope = Buffer.concat([
    Buffer.from(vector.hostFrame.nonce, 'base64url'),
    Buffer.from(vector.hostFrame.ciphertext, 'base64url'),
  ]);
  assert.throws(() => app.openBytes(new Uint8Array(envelope)));
  const wrong = new RelayEncryption(`adk1_${Buffer.alloc(32, 42).toString('base64url')}`, 'app', 'test-phone');
  assert.throws(() => wrong.openBytes(frame));
});

test('encrypted raw file reads arrive as binary frames and resolve with the bytes', async () => {
  const fixture = documentFixture(undefined, { pairingId: vector.id });
  await fixture.connect();
  const read = fixture.app.agentApi.readRawFile('/tmp/a.bin');
  await tick();
  const request = fixture.requests.at(-1);
  assert.equal(request.ephemeral, true);

  // Seal as the daemon does: `[u32 header length][reply JSON][bytes]`, then `[nonce][ciphertext]`.
  const encoder = new TextEncoder();
  const header = encoder.encode(
    JSON.stringify({ id: request.payload.id, peerId: 1, result: { path: '/tmp/a.bin', type: 'binary' } }),
  );
  const plaintext = Buffer.concat([Buffer.alloc(4), header, Buffer.from([0, 1, 2, 255])]);
  plaintext.writeUInt32BE(header.length);
  const secret = Buffer.from(vector.id.slice(5), 'base64url');
  const key = hkdf(sha256, secret, encoder.encode('agentdeck-e2ee-v1'), encoder.encode('host-to-app'), 32);
  const aad = encoder.encode(JSON.stringify(['agentdeck-e2ee-v1', vector.routeId, 'host-to-app', 'host', 'binary']));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const sealed = Buffer.concat([nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext)]);
  const relayHeader = Buffer.from(JSON.stringify({ message_id: 'bin-1' }));
  const relayFrame = Buffer.concat([Buffer.alloc(2), relayHeader, sealed]);
  relayFrame.writeUInt16BE(relayHeader.length);
  fixture.sockets.at(-1).binary(new Uint8Array(relayFrame));

  const file = await read;
  assert.equal(file.type, 'binary');
  assert.deepEqual([...file.data], [0, 1, 2, 255]);
  assert.ok(!sealed.includes(Buffer.from('/tmp/a.bin')));
});

test('plaintext injection cannot establish a connection with an encrypted ID', async () => {
  const fixture = documentFixture(undefined, { pairingId: vector.id });
  fixture.heldMethods.add('peer_attach');
  await fixture.connect();
  fixture.sockets.at(-1).frame({
    type: 'message',
    message_id: 'injected',
    sequence: 1,
    payload: { id: fixture.requests.at(-1).payload.id, result: { peerId: 1 } },
  });
  await tick();
  assert.notEqual(fixture.app.agentdeckStore.connection, 'connected');
  assert.match(fixture.app.agentdeckStore.connectionError, /verification failed/i);
});
