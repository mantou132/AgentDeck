import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

async function runningSession() {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  return fixture;
}

test('does not trigger haptic when a turn completes, fails or is cancelled', async () => {
  const f = await runningSession();
  f.app.sendPrompt('s1', 'Hello agent');
  await tick();
  f.reply(f.requests.at(-1), { answer: 'Hello user' });
  await tick();

  f.app.sendPrompt('s1', 'Do something that fails');
  await tick();
  f.deliver({ id: f.requests.at(-1).payload.id, peerId: 1, error: 'Command failed' });
  await tick();

  f.app.sendPrompt('s1', 'Cancel this');
  await tick();
  f.app.cancelTurn('s1');
  await tick();

  assert.equal(f.haptics.length, 0);
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
