import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
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
const file = { id: 'file', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', data: 'JVBERg==' };

const loadModule = (path) => {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  const customRequire = (id) => {
    if (id === '@mantou/tap-ui/lib/encode') {
      return { arrayBufferToBase64: (buffer) => Buffer.from(buffer).toString('base64') };
    }
    if (id === '@mantou/tap-ui/lib/cache') {
      return {
        Cache: class {
          get = (_, create) => create();
        },
      };
    }
    if (id === '@mantou/tap-ui/lib/image') {
      return { compressionImage: async () => 'data:image/png;base64,abc' };
    }
    return {};
  };
  vm.runInNewContext(outputText, { exports, require: customRequire, crypto, File, Blob });
  return exports;
};

test('mixed attachments reach the host, survive rejection, and can be sent again', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  assert.equal(fixture.app.sendPrompt('s1', 'Review these', [image, text, file]), true);
  await tick();
  const request = fixture.requests.at(-1);
  assert.equal(request.payload.method, 'agent_prompt');
  assert.deepEqual(request.payload.params.attachments, [
    { type: 'image', data: image.data, mimeType: image.mimeType },
    {
      type: 'text',
      text: '<attachment name="notes &amp; &quot;tasks&quot;.md">\n# Task\nReview attachments\n</attachment>',
    },
    { type: 'file', name: file.name, data: file.data, mimeType: file.mimeType },
  ]);
  fixture.sockets.at(-1).frame({ type: 'rejected', message_id: request.message_id, reason: 'queue_full: review' });
  await tick();
  const message = fixture.app.agentdeckStore.messagesBySession.s1.at(-1);
  assert.equal(message.failed, true);
  assert.deepEqual(message.attachments, [image, text, file]);
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
  assert.equal(fixture.app.sendPrompt('s1', message.text, message.attachments), true);
  await tick();
  assert.deepEqual(fixture.requests.at(-1).payload.params.attachments, request.payload.params.attachments);
  fixture.reply(fixture.requests.at(-1), { answer: 'received' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.errorsBySession.s1, '');
  assert.equal(fixture.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'received');
});

test('attachment-only prompts work in both a pending session and an existing session', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  const pendingSession = fixture.app.createPendingSession({ agent: 'codex', cwd: '/tmp' });
  const creation = fixture.app.promotePendingSession(pendingSession, '', [text]);
  await fixture.settleHost();
  const session = await creation;
  fixture.app.resetPendingSession();
  assert.equal(session.title, text.name);
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

test('readAttachment inlines text files, sends other files to the host, and rejects oversized ones', async () => {
  const { readAttachment, MAX_TEXT_BYTES, MAX_FILE_BYTES } = loadModule('attachment/read.ts');

  // Extensionless file (e.g. Dockerfile)
  const dockerfile = new File(['FROM alpine\nRUN echo hello'], 'Dockerfile', { type: '' });
  const dockerResult = await readAttachment(dockerfile);
  assert.equal(dockerResult.kind, 'text');
  assert.equal(dockerResult.name, 'Dockerfile');
  assert.equal(dockerResult.text, 'FROM alpine\nRUN echo hello');

  // File with modern extension (e.g. .vue)
  const vueFile = new File(['<template><div>hi</div></template>'], 'App.vue', { type: '' });
  const vueResult = await readAttachment(vueFile);
  assert.equal(vueResult.kind, 'text');
  assert.equal(vueResult.text, '<template><div>hi</div></template>');

  // Binary file (contains null byte) goes to the host as a file
  const binaryFile = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00])], 'report.pdf', {
    type: 'application/pdf',
  });
  const binaryResult = await readAttachment(binaryFile);
  assert.equal(binaryResult.kind, 'file');
  assert.equal(binaryResult.mimeType, 'application/pdf');
  assert.equal(binaryResult.data, 'JVBERgA=');

  // Text beyond the inline limit is sent as a file too
  const bigTextFile = new File(['a'.repeat(MAX_TEXT_BYTES + 1)], 'big.txt', { type: 'text/plain' });
  assert.equal((await readAttachment(bigTextFile)).kind, 'file');

  // Files beyond the Relay budget are rejected
  const hugeFile = new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'huge.zip', { type: 'application/zip' });
  await assert.rejects(readAttachment(hugeFile), { reason: 'tooLarge', fileName: 'huge.zip' });
});

test('files saved on the host are restored from history as attachments', () => {
  const { extractMessageAttachments } = documentFixture().app;
  const uri = 'file:///var/folders/T/agentdeck-attachments/20261007-0/Q3_report.pdf';
  const { attachments, markdown } = extractMessageAttachments(
    `Summarize this[@Q3_report.pdf](${uri}) and [@a.ts](file:///repo/a.ts)`,
    'Image',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(attachments)), [{ id: uri, kind: 'file', name: 'Q3_report.pdf', uri }]);
  assert.equal(markdown, 'Summarize this and [@a.ts](file:///repo/a.ts)');
});

test('a file restored from history is sent again as a resource link', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  const uri = 'file:///tmp/agentdeck-attachments/1/report.pdf';
  fixture.app.sendPrompt('s1', 'Again', [{ id: uri, kind: 'file', name: 'report.pdf', uri }]);
  await tick();
  assert.deepEqual(fixture.requests.at(-1).payload.params.attachments, [{ type: 'resource', uri, name: 'report.pdf' }]);
});
