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

const loadFilesModule = () => {
  const source = readFileSync(new URL('../src/composer/files.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  });
  const en = JSON.parse(readFileSync(new URL('../src/locales/en/basic.json', import.meta.url), 'utf8'));
  const exports = {};
  const customRequire = (id) => {
    if (id === '../i18n') {
      return {
        i18n: {
          get: (key, ...args) => {
            const raw = en[key] || key;
            return raw.replace(/\$(\d+)/g, (_, i) => args[Number(i) - 1] ?? '');
          },
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

test('readAttachment accepts code, extensionless text files, and rejects binaries with i18n error', async () => {
  const { readAttachment, MAX_TEXT_BYTES } = loadFilesModule();

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

  // Binary file (contains null byte)
  const binaryFile = new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01])], 'app.bin', { type: '' });
  await assert.rejects(
    async () => readAttachment(binaryFile),
    (err) => {
      assert.match(err.message, /app\.bin.*not supported/i);
      return true;
    },
  );

  // Oversized text file
  const bigTextFile = new File(['a'.repeat(MAX_TEXT_BYTES + 1)], 'big.txt', { type: 'text/plain' });
  await assert.rejects(
    async () => readAttachment(bigTextFile),
    (err) => {
      assert.match(err.message, /big\.txt.*exceeds 256 KB/i);
      return true;
    },
  );
});
