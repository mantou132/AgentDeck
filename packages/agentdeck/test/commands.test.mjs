import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

const availableCommands = [
  { name: 'review', description: 'Review changes' },
  { name: 'init', description: 'Create AGENTS.md' },
];

test('commands announced between turns are kept per agent across restarts', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();
  f.emitEvent('s1', {
    event: 'session_update',
    update: { sessionUpdate: 'available_commands_update', availableCommands },
  });
  await tick();
  assert.deepEqual(plain(f.app.agentdeckStore.commandsByAgent.codex), availableCommands);

  const restarted = documentFixture(f);
  assert.deepEqual(plain(restarted.app.agentdeckStore.commandsByAgent), { codex: availableCommands });
});
