import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

async function runningSession() {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  return fixture;
}

test('triggers success notification haptic when agent completes turn answering', async () => {
  const f = await runningSession();
  assert.equal(f.haptics.length, 0);

  f.app.sendPrompt('s1', 'Hello agent');
  await tick();
  const prompt = f.requests.at(-1);

  // Still streaming/processing - no success haptic yet
  assert.equal(f.haptics.filter((h) => h.type === 'notification' && h.value === 'success').length, 0);

  // Complete prompt reply
  f.reply(prompt, { answer: 'Hello user' });
  await tick();

  const successHaptics = f.haptics.filter((h) => h.type === 'notification' && h.value === 'success');
  assert.equal(successHaptics.length, 1);
});

test('triggers warning notification haptic when agent encounters permission request requiring approval', async () => {
  const f = await runningSession();
  f.app.sendPrompt('s1', 'Run shell command');
  await tick();

  assert.equal(f.haptics.filter((h) => h.type === 'notification' && h.value === 'warning').length, 0);

  // Agent emits permission request
  f.deliver({
    id: 'perm-req-1',
    method: 'agent_permission_request',
    peerId: 1,
    params: {
      agent: 'codex',
      sessionId: 's1',
      toolCall: { title: 'Execute bash command' },
      options: [
        { optionId: 'approve', name: 'Approve' },
        { optionId: 'deny', name: 'Deny' },
      ],
    },
  });
  await tick();

  // Permission request is displayed in store and warning haptic was triggered
  assert.ok(f.app.agentdeckStore.permissionsBySession.s1);
  const warningHaptics = f.haptics.filter((h) => h.type === 'notification' && h.value === 'warning');
  assert.equal(warningHaptics.length, 1);
});

test('does not trigger success haptic when turn fails or is cancelled', async () => {
  const f = await runningSession();
  f.app.sendPrompt('s1', 'Do something that fails');
  await tick();
  const prompt = f.requests.at(-1);

  // Deliver error
  f.deliver({ id: prompt.payload.id, peerId: 1, error: 'Command failed' });
  await tick();

  const successHaptics = f.haptics.filter((h) => h.type === 'notification' && h.value === 'success');
  assert.equal(successHaptics.length, 0);

  // Cancelled prompt
  f.app.sendPrompt('s1', 'Cancel this');
  await tick();
  f.app.cancelTurn('s1');
  await tick();

  assert.equal(f.haptics.filter((h) => h.type === 'notification' && h.value === 'success').length, 0);
});
