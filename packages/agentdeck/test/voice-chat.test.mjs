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
