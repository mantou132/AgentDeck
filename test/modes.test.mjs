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
  f.reply(request(f, 'agent_prompt'), { answer: 'done' });
  await tick();
});

for (const options of [{ modes }, { configOptions }]) {
  for (const finishesFirst of ['mode', 'prompt']) {
    test(`mode changes during a prompt using ${options.modes ? 'modes' : 'config'}; ${finishesFirst} finishes first`, async () => {
      const fixture = await opened(options);
      const session = fixture.app.getSession('s1');
      assert.equal(fixture.app.sendPrompt('s1', 'First task'), true);
      await tick();
      const prompt = request(fixture, 'agent_prompt');
      const change = fixture.app.changeSessionMode(session, 'plan');
      await tick();
      const method = options.modes ? 'agent_session_set_mode' : 'agent_session_set_config_option';
      const modeRequest = request(fixture, method);
      assert.ok(modeRequest);
      assert.equal(selection(fixture).currentValue, 'default');
      assert.equal(await fixture.app.changeSessionMode(session, 'plan'), false);
      assert.equal(fixture.app.sendPrompt('s1', 'Too early'), false);

      const finishMode = async () => {
        fixture.reply(
          modeRequest,
          options.modes
            ? {}
            : {
                configOptions: [{ ...configOptions[0], currentValue: 'plan' }, configOptions[1]],
              },
        );
        assert.equal(await change, true);
        assert.equal(selection(fixture).currentValue, 'plan');
      };
      const finishPrompt = async () => {
        fixture.reply(prompt, { answer: 'Done' });
        await tick();
        assert.equal(fixture.app.agentdeckStore.pendingSessionIds.length, 0);
      };
      if (finishesFirst === 'mode') await finishMode();
      else await finishPrompt();
      assert.equal(fixture.app.sendPrompt('s1', 'Still too early'), false);
      if (finishesFirst === 'mode') await finishPrompt();
      else await finishMode();

      const attachments = [{ id: 'notes', name: 'notes.txt', kind: 'text', text: 'Next task notes' }];
      assert.equal(fixture.app.sendPrompt('s1', 'Next task', attachments), true);
      await tick();
      const nextPrompt = request(fixture, 'agent_prompt');
      assert.equal(nextPrompt.payload.params.prompt, 'Next task');
      assert.deepEqual(nextPrompt.payload.params.attachments, [
        { type: 'text', text: '<attachment name="notes.txt">\nNext task notes\n</attachment>' },
      ]);
      fixture.reply(nextPrompt, { answer: 'Next answer' });
      await tick();
    });
  }
}

test('rejected mode changes during a prompt leave the running task intact and permit retry', async () => {
  const fixture = await opened();
  const session = fixture.app.getSession('s1');
  assert.equal(fixture.app.sendPrompt('s1', 'Running task'), true);
  await tick();
  const prompt = request(fixture, 'agent_prompt');
  let change = fixture.app.changeSessionMode(session, 'plan');
  await tick();
  failed(fixture, request(fixture, 'agent_session_set_mode'));
  assert.equal(await change, false);
  assert.equal(selection(fixture).currentValue, 'default');
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
  assert.equal(fixture.app.agentdeckStore.messagesBySession.s1[0].failed, undefined);
  change = fixture.app.changeSessionMode(session, 'plan');
  await tick();
  fixture.reply(request(fixture, 'agent_session_set_mode'), {});
  assert.equal(await change, true);
  fixture.reply(prompt, { answer: 'Done' });
  await tick();
  assert.equal(fixture.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'Done');
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
