import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

async function running() {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'Review permissions');
  await tick();
  return fixture;
}

for (const outcome of ['completed', 'failed']) {
  test(`a ${outcome} task dismisses its pending permission and allows a new task`, async () => {
    const f = await running();
    const prompt = f.requests.at(-1);
    f.deliver({
      id: 'permission',
      method: 'agent_permission_request',
      peerId: 1,
      params: {
        agent: 'codex',
        sessionId: 's1',
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
    });
    await tick();
    assert.ok(f.app.agentdeckStore.permissionsBySession.s1);
    if (outcome === 'failed') f.deliver({ id: prompt.payload.id, peerId: 1, error: 'Agent stopped' });
    else f.reply(prompt, { answer: 'Done' });
    await tick();
    assert.equal(f.app.agentdeckStore.permissionsBySession.s1, undefined);
    assert.ok(f.requests.find((request) => request.payload.id === 'permission')?.payload.error);
    assert.equal(f.app.agentdeckStore.pendingSessionIds.length, 0);
    assert.equal(f.app.sendPrompt('s1', 'Next task'), true);
    await tick();
    f.reply(f.requests.at(-1), { answer: 'Next answer' });
    await tick();
    assert.equal(f.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'Next answer');
  });
}

test('cancelling an unknown remote task shows the reset recovery path', async () => {
  const f = await running();
  f.app.cancelTurn('s1');
  await tick();
  const cancel = f.requests.at(-1);
  assert.equal(cancel.payload.method, 'agent_prompt_cancel');
  f.reply(cancel, { cancelled: false });
  await tick();
  assert.match(f.app.agentdeckStore.errorsBySession.s1, /重置 App/);
  f.app.hardResetApp();
  const fresh = documentFixture(f);
  await fresh.connect();
  await fresh.openSession();
  assert.equal(fresh.app.sendPrompt('s1', 'Recovered task'), true);
  await tick();
  fresh.reply(fresh.requests.at(-1), { answer: 'Recovered' });
  await tick();
  assert.equal(fresh.app.agentdeckStore.pendingSessionIds.length, 0);
});
