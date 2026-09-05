import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const modes = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan' },
  ],
};
const configOptions = [
  {
    id: 'permission',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      {
        group: 'modes',
        name: 'Modes',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ],
  },
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'model-a',
    options: [{ value: 'model-a', name: 'Model A' }],
  },
];

async function opened(options = { modes }) {
  const fixture = documentFixture();
  fixture.heldMethods.add('agent_session_load');
  await fixture.connect();
  const loading = fixture.app.ensureSessionLoaded('s1');
  await fixture.settleHost();
  fixture.reply(fixture.requests.at(-1), { sessionId: 's1', ...options });
  await loading;
  return fixture;
}
const selection = (f, id = 's1') => f.app.getModeSelection(f.app.agentdeckStore.optionsBySession[id]);
const request = (f, method) => f.requests.findLast((r) => r.payload.method === method);
const failed = (f, req) => f.deliver({ id: req.payload.id, error: 'mode rejected', peerId: 1 });

async function creating(f) {
  const draft = f.app.createDraftSession({ agent: 'codex', cwd: '/tmp' });
  assert.equal(selection(f, 'draft').currentValue, '');
  assert.equal(await f.app.changeSessionMode(draft, 'plan'), true);
  assert.equal(request(f, 'agent_session_create'), undefined);
  f.heldMethods.add('agent_session_create');
  const promotion = f.app.promoteDraftSession(draft, 'First task', [
    { id: 'notes', name: 'notes.txt', kind: 'text', text: 'keep me' },
  ]);
  await f.settleHost();
  return { promotion, creation: request(f, 'agent_session_create') };
}

test('mode selection uses reported capabilities; current-mode and config events stay in sync', async () => {
  const f = await opened({ modes, configOptions });
  assert.equal(selection(f).configId, undefined);
  f.app.applySessionEvent('s1', {
    event: 'session_update',
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
  });
  assert.equal(selection(f).currentValue, 'plan');
  assert.equal(f.app.agentdeckStore.optionsBySession.s1.configOptions[0].currentValue, 'plan');
  assert.equal(f.app.agentdeckStore.optionsBySession.s1.configOptions[1].currentValue, 'model-a');
  assert.equal(f.app.getModeSelection({ configOptions: [configOptions[1]] }), undefined);
  assert.equal(f.app.getModeSelection({ modes: null, configOptions: null }), undefined);
});

test('mode change confirms the value before sending; rejection and timeout permit retry', async () => {
  const f = await opened();
  const session = f.app.getSession('s1');
  let change = f.app.changeSessionMode(session, 'plan');
  await tick();
  assert.equal(selection(f).currentValue, 'default');
  assert.equal(f.app.sendPrompt('s1', 'too soon'), false);
  assert.equal(await f.app.changeSessionMode(session, 'plan'), false);
  assert.deepEqual(request(f, 'agent_session_set_mode').payload.params, {
    agent: 'codex',
    sessionId: 's1',
    modeId: 'plan',
  });
  failed(f, request(f, 'agent_session_set_mode'));
  assert.equal(await change, false);
  assert.equal(selection(f).currentValue, 'default');
  assert.equal(f.app.agentdeckStore.changingModeSessionIds.length, 0);
  change = f.app.changeSessionMode(session, 'plan');
  await f.advance(15_000);
  assert.equal(await change, false);
  assert.match(f.app.agentdeckStore.errorsBySession.s1, /切换模式超时/);
  change = f.app.changeSessionMode(session, 'plan');
  await tick();
  f.reply(request(f, 'agent_session_set_mode'), {});
  assert.equal(await change, true);
  assert.equal(selection(f).currentValue, 'plan');
  assert.equal(f.app.sendPrompt('s1', 'now ready'), true);
  await tick();
  assert.equal(await f.app.changeSessionMode(session, 'default'), false);
  f.reply(request(f, 'agent_prompt'), { answer: 'done' });
  await tick();
});

test('config-only mode uses its reported ID and the server response; unrelated options are preserved', async () => {
  const f = await opened({ configOptions });
  assert.equal(selection(f).choices.length, 2);
  const change = f.app.changeSessionMode(f.app.getSession('s1'), 'plan');
  await tick();
  assert.deepEqual(request(f, 'agent_session_set_config_option').payload.params, {
    agent: 'codex',
    sessionId: 's1',
    configId: 'permission',
    value: 'plan',
  });
  f.reply(request(f, 'agent_session_set_config_option'), {
    configOptions: [{ ...configOptions[0], currentValue: 'plan' }, configOptions[1]],
  });
  assert.equal(await change, true);
  assert.equal(selection(f).currentValue, 'plan');
  assert.equal(f.app.agentdeckStore.optionsBySession.s1.configOptions[1].currentValue, 'model-a');
  f.app.applySessionEvent('s1', {
    event: 'session_update',
    update: { sessionUpdate: 'config_option_update', configOptions },
  });
  assert.equal(selection(f).currentValue, 'default');
});

test('draft mode is applied after create and before the first prompt', async () => {
  const f = await opened();
  const { promotion, creation } = await creating(f);
  f.reply(creation, { sessionId: 'created', modes });
  await tick();
  assert.equal(request(f, 'agent_prompt'), undefined);
  assert.equal(request(f, 'agent_session_set_mode').payload.params.sessionId, 'created');
  f.reply(request(f, 'agent_session_set_mode'), {});
  const live = await promotion;
  await tick();
  assert.equal(selection(f, live.sessionId).currentValue, 'plan');
  assert.equal(request(f, 'agent_prompt').payload.params.prompt, 'First task');
  f.reply(request(f, 'agent_prompt'), { answer: 'planned' });
  await tick();
});

for (const scenario of ['rejected', 'unsupported']) {
  test(`draft mode ${scenario} keeps the created session and input recoverable without sending`, async () => {
    const f = await opened();
    const { promotion, creation } = await creating(f);
    f.reply(creation, { sessionId: 'created', ...(scenario === 'rejected' ? { modes } : {}) });
    await tick();
    if (scenario === 'rejected') failed(f, request(f, 'agent_session_set_mode'));
    const live = await promotion;
    assert.equal(live.sessionId, 'created');
    assert.equal(request(f, 'agent_prompt'), undefined);
    assert.equal(f.app.agentdeckStore.pendingSessionIds.length, 0);
    const message = f.app.agentdeckStore.messagesBySession.created[0];
    assert.equal(message.failed, true);
    assert.equal(message.text, 'First task');
    assert.equal(message.attachments[0].text, 'keep me');
    assert.ok(f.app.agentdeckStore.errorsBySession.created);
    assert.equal(f.app.sendPrompt('created', message.text, message.attachments), true);
    await tick();
    f.reply(request(f, 'agent_prompt'), { answer: 'retry' });
    await tick();
    assert.equal(f.requests.filter((r) => r.payload.method === 'agent_session_create').length, 1);
  });
}

test('first draft uses agent default and captures capabilities; cancel during mode setup sends no prompt', async () => {
  const f = documentFixture();
  await f.connect();
  const draft = f.app.createDraftSession({ agent: 'codex', cwd: '/tmp' });
  assert.equal(selection(f, 'draft'), undefined);
  f.heldMethods.add('agent_session_create');
  let promotion = f.app.promoteDraftSession(draft, 'default');
  await tick();
  f.reply(request(f, 'agent_session_create'), { sessionId: 'created', modes });
  await promotion;
  await tick();
  assert.equal(selection(f, 'created').currentValue, 'default');
  assert.equal(request(f, 'agent_session_set_mode'), undefined);
  f.reply(request(f, 'agent_prompt'), { answer: 'done' });
  await tick();
  const next = f.app.createDraftSession({ agent: 'codex', cwd: '/tmp' });
  await f.app.changeSessionMode(next, 'plan');
  promotion = f.app.promoteDraftSession(next, 'cancel');
  await tick();
  f.reply(request(f, 'agent_session_create'), { sessionId: 'next', modes });
  await tick();
  f.app.cancelTurn('draft');
  f.reply(request(f, 'agent_session_set_mode'), {});
  assert.equal(await promotion, null);
  await tick();
  assert.equal(request(f, 'agent_session_close').payload.params.sessionId, 'next');
  assert.equal(f.requests.filter((r) => r.payload.method === 'agent_prompt').length, 1);
});
