import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture } from './helpers/app-fixture.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('voice chat prompts ask the agent for a spoken summary without showing the request', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  assert.equal(fixture.app.sendPrompt('s1', 'Run the tests', [], undefined, true), true);
  await tick();
  const request = fixture.requests.at(-1);
  assert.equal(request.payload.params.prompt, 'Run the tests');
  assert.equal(request.payload.params.voiceChat, true);
  assert.deepEqual(request.payload.params.attachments, []);
  // History replays the daemon's marker as part of the user message.
  assert.equal(fixture.app.stripVoiceChatMarker('Run the tests<agentdeck-voice-chat/>'), 'Run the tests');
});

test('reply speech prefers the agentdeck-speech comment and falls back to plain reply text', () => {
  const { replySpeech } = documentFixture().app;
  assert.equal(
    replySpeech('Fixed it.\n\n```ts\nconst a = 1;\n```\n\n<!-- agentdeck-speech\nTests pass now.\n-->'),
    'Tests pass now.',
  );
  assert.equal(
    replySpeech('## Result\n\n- Updated [the config](a.md) and `pnpm test`\n\n```sh\nls\n```'),
    'Result Updated the config and pnpm test',
  );
  assert.equal(replySpeech('a'.repeat(300)).length, 201);
});

test('language setting persists, updates i18n, and drives speech recognition and synthesis', async () => {
  const fixture = documentFixture(undefined, { navigator: { language: 'en-GB' } });
  const { app, localStorage, sttCalls, ttsCalls } = fixture;

  // Defaults to follow system.
  assert.equal(app.agentdeckStore.language, '');
  assert.equal(app.i18n.currentLanguage, 'en');
  assert.equal(app.speechLanguage(), 'en-GB');

  // Switch to Simplified Chinese while OS language is English.
  await app.setLanguage('zh-CN');
  assert.equal(localStorage.getItem(app.LANGUAGE_KEY), 'zh-CN');
  assert.equal(app.agentdeckStore.language, 'zh-CN');
  assert.equal(app.i18n.currentLanguage, 'zh-CN');
  assert.equal(app.speechLanguage(), 'zh-CN');

  const stop = await app.startRecognitionSession({ onTranscript: () => {}, onError: () => {} });
  await stop();
  await app.speakText('你好');
  assert.deepEqual({ ...sttCalls.at(-1) }, { language: 'zh-CN', interimResults: true });
  assert.deepEqual({ ...ttsCalls.at(-1) }, { text: '你好', language: 'zh-CN', queueMode: 'flush' });

  // Persists across reload.
  const reloaded = documentFixture(fixture, { navigator: { language: 'en-GB' } });
  assert.equal(reloaded.app.readLanguage(), 'zh-CN');
  assert.equal(reloaded.app.agentdeckStore.language, 'zh-CN');
  assert.equal(reloaded.app.i18n.currentLanguage, 'zh-CN');
  assert.equal(reloaded.app.speechLanguage(), 'zh-CN');

  // Switch to English explicitly: uses en-US regardless of OS language.
  await reloaded.app.setLanguage('en-US');
  assert.equal(reloaded.app.i18n.currentLanguage, 'en-US');
  assert.equal(reloaded.app.speechLanguage(), 'en-US');
  const zhOs = documentFixture(reloaded, { navigator: { language: 'zh-CN' } });
  assert.equal(zhOs.app.speechLanguage(), 'en-US');

  // Reset to follow system.
  await zhOs.app.setLanguage('');
  assert.equal(localStorage.getItem(zhOs.app.LANGUAGE_KEY), null);
  assert.equal(zhOs.app.agentdeckStore.language, '');
  assert.equal(zhOs.app.i18n.currentLanguage, 'zh-CN');
  assert.equal(zhOs.app.speechLanguage(), 'zh-CN');
});
