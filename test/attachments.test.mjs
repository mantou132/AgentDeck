import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const image = {
  id: 'image',
  kind: 'image',
  name: 'screen.png',
  mimeType: 'image/png',
  data: 'aW1hZ2U=',
  previewUrl: 'data:image/png;base64,aW1hZ2U=',
};
const text = { id: 'text', kind: 'text', name: 'notes & "tasks".md', text: '# Task\nReview attachments' };

test('mixed attachments reach the host, survive rejection, and can be sent again', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  assert.equal(fixture.app.sendPrompt('s1', 'Review these', [image, text]), true);
  await tick();
  const request = fixture.requests.at(-1);
  assert.equal(request.payload.method, 'agent_prompt');
  assert.deepEqual(request.payload.params.attachments, [
    { type: 'image', data: image.data, mimeType: image.mimeType },
    {
      type: 'text',
      text: '<attachment name="notes &amp; &quot;tasks&quot;.md">\n# Task\nReview attachments\n</attachment>',
    },
  ]);
  fixture.sockets.at(-1).frame({ type: 'rejected', message_id: request.message_id, reason: 'queue_full: review' });
  await tick();
  const message = fixture.app.agentdeckStore.messagesBySession.s1.at(-1);
  assert.equal(message.failed, true);
  assert.deepEqual(message.attachments, [image, text]);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.equal(fixture.app.sendPrompt('s1', message.text, message.attachments), true);
  await tick();
  assert.deepEqual(fixture.requests.at(-1).payload.params.attachments, request.payload.params.attachments);
  fixture.reply(fixture.requests.at(-1), { answer: 'received' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.errorsBySession.s1, '');
  assert.equal(fixture.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'received');
});

test('attachment-only prompts work in both a draft and an existing session', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  const draft = fixture.app.createDraftSession({ agent: 'codex', cwd: '/tmp' });
  const creation = fixture.app.promoteDraftSession(draft, '', [text]);
  await fixture.settleHost();
  const session = await creation;
  assert.equal(session.title, text.name);
  assert.equal(fixture.app.agentdeckStore.draftSession, null);
  assert.deepEqual(fixture.app.agentdeckStore.messagesBySession[session.sessionId][0].attachments, [text]);
  const request = fixture.requests.at(-1);
  assert.equal(request.payload.params.prompt, '');
  assert.equal(request.payload.params.attachments.length, 1);
  fixture.reply(request, { answer: 'created and received' });
  await tick();
  assert.equal(fixture.app.sendPrompt(session.sessionId, '', [image]), true);
  await tick();
  assert.deepEqual(fixture.requests.at(-1).payload.params.attachments, [
    { type: 'image', data: image.data, mimeType: image.mimeType },
  ]);
  fixture.reply(fixture.requests.at(-1), { answer: 'image received' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.equal(fixture.app.sendPrompt(session.sessionId, '', []), false);
});

test('an oversized image stays recoverable without being enqueued', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  const largeImage = { ...image, data: 'a'.repeat(10 * 1024 * 1024) };
  const count = fixture.requests.length;
  fixture.app.sendPrompt('s1', '', [largeImage]);
  await tick();
  assert.equal(fixture.requests.length, count);
  assert.match(fixture.app.agentdeckStore.errorsBySession.s1, /too large/i);
  const message = fixture.app.agentdeckStore.messagesBySession.s1.at(-1);
  assert.equal(message.failed, true);
  assert.equal(message.attachments[0], largeImage);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
});
