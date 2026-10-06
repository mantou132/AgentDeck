import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

// The shape claude-agent-acp builds for `AskUserQuestion` (keys come back sorted from the host).
const askRequest = (requestId = 'r1') => ({
  agent: 'codex',
  sessionId: 's1',
  requestId,
  toolCallId: 'ask',
  mode: 'form',
  message: 'Please answer the following questions.',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        title: 'Cache',
        description: 'Which cache?',
        oneOf: [
          { const: 'Redis', title: 'Redis', description: 'In memory' },
          { const: 'None', title: 'None' },
        ],
      },
      question_0_custom: { type: 'string', title: 'Other' },
      question_1: { type: 'array', title: 'Targets', items: { anyOf: [{ const: 'iOS' }, { const: 'Android' }] } },
      question_1_custom: { type: 'string', title: 'Other' },
    },
  },
});

async function running() {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'Plan the cache');
  await tick();
  return fixture;
}

test('questions pair each select with its custom answer field', () => {
  const { app } = documentFixture();
  const questions = plain(app.getElicitationQuestions(askRequest()));
  assert.deepEqual(
    questions.map(({ select, input }) => [select.key, select.kind, input.key]),
    [
      ['question_0', 'single', 'question_0_custom'],
      ['question_1', 'multi', 'question_1_custom'],
    ],
  );
  assert.deepEqual(questions[0].select.choices[0], { value: 'Redis', title: 'Redis', description: 'In memory' });
  assert.equal(questions[1].select.choices[1].title, 'Android');
});

test('content keeps filled fields and waits for required ones', () => {
  const { app } = documentFixture();
  const questions = app.getElicitationQuestions(askRequest());
  assert.equal(app.getElicitationContent(questions, {}), undefined);
  assert.equal(app.getElicitationContent(questions, { question_1: [], question_0_custom: '  ' }), undefined);
  assert.deepEqual(
    plain(
      app.getElicitationContent(questions, { question_0: 'Redis', question_1: ['iOS'], question_1_custom: ' Web ' }),
    ),
    { question_0: 'Redis', question_1: ['iOS'], question_1_custom: 'Web' },
  );

  const form = app.getElicitationQuestions({
    ...askRequest(),
    requestedSchema: {
      properties: { name: { type: 'string' }, count: { type: 'integer' } },
      required: ['count'],
    },
  });
  assert.equal(app.getElicitationContent(form, { name: 'A' }), undefined);
  assert.deepEqual(plain(app.getElicitationContent(form, { count: '3' })), { count: 3 });
});

test('a question follows the tool call that asked it and splits its process group', () => {
  const { app } = documentFixture();
  const tool = (id) => ({ id, type: 'tool', data: { toolCallId: id, title: id, status: 'completed' } });
  const messages = [{ id: 'user', role: 'user', text: 'Go' }, tool('read'), tool('ask'), tool('write')];
  const asked = { request: askRequest() };
  const other = { request: { ...askRequest('r2'), toolCallId: undefined } };
  const items = app.groupTimelineMessages(messages, true, [other, asked]);
  assert.deepEqual(
    plain(items.map((item) => (item.type === 'group' ? item.group.items.map((i) => i.id) : item.type))),
    ['message', ['read', 'ask'], 'elicitation', ['write'], 'elicitation'],
  );
  assert.equal(items[2].elicitation, asked);
  assert.equal(items[4].elicitation, other);
});

const permissionRequest = (requestId = 'p1') => ({
  agent: 'codex',
  sessionId: 's1',
  requestId,
  toolCall: { title: 'Run tests' },
  options: [{ optionId: 'allow', name: 'Allow' }],
});

test('a question of a running turn is shown once, answered through the host and settled with the turn', async () => {
  const f = await running();
  const prompt = f.requests.find((request) => request.payload.method === 'agent_prompt');
  const store = f.app.agentdeckStore;
  for (let i = 0; i < 2; i++) f.deliver({ method: 'agent_elicitation_request', peerId: 1, params: askRequest() });
  await tick();
  assert.equal(store.elicitationsBySession.s1.length, 1);

  const answering = f.app.answerElicitation(store.elicitationsBySession.s1[0].request, {
    action: 'accept',
    content: { question_0: 'Redis' },
  });
  await tick();
  assert.equal(store.elicitationsBySession.s1[0].response.action, 'accept');
  const respond = f.requests.find((request) => request.payload.method === 'agent_user_input_respond');
  assert.deepEqual(plain(respond.payload.params), {
    agent: 'codex',
    sessionId: 's1',
    requestId: 'r1',
    response: { action: 'accept', content: { question_0: 'Redis' } },
  });
  f.deliver({ id: respond.payload.id, peerId: 1, error: 'The request is no longer pending' });
  await answering;
  assert.equal(store.elicitationsBySession.s1[0].response, undefined, 'answerable again when not taken');

  f.reply(prompt, { answer: 'Done' });
  await tick();
  assert.equal(store.elicitationsBySession.s1[0].response.action, 'cancel');
});

test('a permission is answered through the host and comes back when the answer is not taken', async () => {
  const f = await running();
  const store = f.app.agentdeckStore;
  f.deliver({ method: 'agent_permission_request', peerId: 1, params: permissionRequest() });
  await tick();
  const resolving = f.app.resolvePermission('s1', 'allow');
  assert.equal(store.permissionsBySession.s1, undefined);
  await tick();
  const respond = f.requests.find((request) => request.payload.method === 'agent_user_input_respond');
  assert.deepEqual(plain(respond.payload.params.response), { optionId: 'allow' });
  f.deliver({ id: respond.payload.id, peerId: 1, error: 'Not delivered' });
  await resolving;
  assert.equal(store.permissionsBySession.s1.requestId, 'p1');

  f.app.resolvePermission('s1', null);
  await tick();
  const cancel = f.requests.findLast((request) => request.payload.method === 'agent_user_input_respond');
  assert.deepEqual(plain(cancel.payload.params.response), {});
});

test('requests are ignored once the turn is not running', async () => {
  const f = documentFixture();
  await f.connect();
  await f.openSession();
  f.deliver({ method: 'agent_elicitation_request', peerId: 1, params: askRequest() });
  f.deliver({ method: 'agent_permission_request', peerId: 1, params: permissionRequest() });
  await tick();
  assert.equal(f.app.agentdeckStore.elicitationsBySession.s1, undefined);
  assert.equal(f.app.agentdeckStore.permissionsBySession.s1, undefined);
});

for (const [method, params, read] of [
  ['agent_elicitation_request', askRequest(), (store) => store.elicitationsBySession.s1[0].request],
  ['agent_permission_request', permissionRequest(), (store) => store.permissionsBySession.s1],
]) {
  test(`an unanswered ${method} is shown again after the App reloads`, async () => {
    const fixture = await running();
    fixture.deliver({ method, peerId: 1, params });
    await tick();
    const fresh = documentFixture(fixture);
    await fresh.connect();
    const query = fresh.requests.find((request) => request.payload.method === 'agent_prompts_running');
    fresh.reply(query, { sessions: [{ agent: 'codex', sessionId: 's1' }], userInputs: [{ method, params }] });
    await fresh.settleHost();
    assert.equal(read(fresh.app.agentdeckStore).requestId, params.requestId);
  });
}
