import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture } from './helpers/app-fixture.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

async function running() {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  fixture.app.sendPrompt('s1', 'Delegate it');
  await fixture.settleHost();
  const prompt = fixture.requests.find((request) => request.payload.method === 'agent_prompt');
  const send = (update, childSessionId) =>
    fixture.deliver({ id: prompt.payload.id, event: { event: 'session_update', update, childSessionId }, peerId: 1 });
  return { fixture, prompt, send };
}

const kinds = (messages) =>
  plain(messages).map((message) =>
    message.type === 'subagent' ? `subagent:${message.sessionId}` : (message.type ?? message.role),
  );

// The order claude-agent-acp reports a launch in (live and on load).
const launch = (send) => {
  send({
    sessionUpdate: 'subagent_update',
    sessionId: 'child',
    title: 'Scout',
    description: 'general-purpose',
    capabilities: { cancel: {} },
    state: { state: 'running' },
  });
  send({
    sessionUpdate: 'session_message',
    messageId: 'toolu_1',
    senderSessionId: 's1',
    recipientSessionId: 'child',
    content: [{ type: 'text', text: 'List the files' }],
  });
  send(
    {
      sessionUpdate: 'session_message',
      messageId: 'toolu_1',
      senderSessionId: 's1',
      recipientSessionId: 'child',
      content: [{ type: 'text', text: 'List the files' }],
    },
    'child',
  );
  send({ sessionUpdate: 'tool_call', toolCallId: 'bash', title: 'ls', status: 'pending' }, 'child');
};

test('a subagent shows as a card in its root session and keeps its own messages', async () => {
  const { fixture, send } = await running();
  const { app } = fixture;
  launch(send);
  send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child is working' } }, 'child');
  // The reply reaches the parent as an incoming message; the card stands for it.
  send({
    sessionUpdate: 'session_message',
    messageId: 'toolu_1:reply',
    senderSessionId: 'child',
    recipientSessionId: 's1',
    content: [{ type: 'text', text: 'Done' }],
  });
  await fixture.settleHost();

  assert.deepEqual(kinds(app.getMessages('s1')), ['user', 'subagent:child']);
  assert.deepEqual(kinds(app.getMessages('child')), ['user', 'tool', 'agent']);
  assert.equal(app.getMessages('child')[0].sessionMessageId, 'toolu_1');
  assert.deepEqual(plain(app.getRuntime('s1').subagents), {
    child: { title: 'Scout', description: 'general-purpose', state: { state: 'running' }, cancellable: true },
  });

  send({ sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'idle', stopReason: 'end_turn' } });
  await fixture.settleHost();
  assert.equal(app.getRuntime('s1').subagents.child.cancellable, true, 'a state patch keeps the other fields');
  assert.deepEqual(kinds(app.getMessages('s1')), ['user', 'subagent:child'], 'one card per subagent');
});

test('a launch reported as a tool call keeps its row next to the card', async () => {
  const { fixture, send } = await running();
  send({ sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Agent', status: 'in_progress' });
  send({ sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'running' } });
  await fixture.settleHost();
  assert.deepEqual(kinds(fixture.app.getMessages('s1')), ['user', 'tool', 'subagent:child']);
});

test('a subagent request waits on the root session; cancelling settles only its own', async () => {
  const { fixture, send } = await running();
  const { app } = fixture;
  launch(send);
  fixture.deliver({
    method: 'agent_elicitation_request',
    peerId: 1,
    params: { agent: 'codex', sessionId: 's1', requestId: 'q1', message: 'Pick one', requestedSchema: {} },
  });
  fixture.deliver({
    method: 'agent_permission_request',
    peerId: 1,
    params: { agent: 'codex', sessionId: 's1', childSessionId: 'child', requestId: 'p1', toolCall: { title: 'ls' } },
  });
  await fixture.settleHost();
  assert.equal(app.getRuntime('s1').permission.childSessionId, 'child');

  app.cancelSubagent('s1', 'child');
  await fixture.settleHost();
  const cancel = fixture.requests.find((request) => request.payload.method === 'agent_prompt_cancel');
  assert.deepEqual(plain(cancel.payload.params), { agent: 'codex', sessionId: 's1', childSessionId: 'child' });
  // The host settles the cancelled subagent's requests; its state says so.
  send({ sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'idle', stopReason: 'cancelled' } });
  await fixture.settleHost();
  assert.equal(app.getRuntime('s1').permission, undefined);
  assert.equal(app.getRuntime('s1').elicitations.length, 1, "the root session's question still waits");
  assert.equal(app.getRuntime('s1').elicitations[0].response, undefined);
});

test('updates of a subagent never change the root session', async () => {
  const { fixture, send } = await running();
  const { app } = fixture;
  const title = app.getSession('s1').title;
  // Not announced yet: still kept apart.
  send({ sessionUpdate: 'session_info_update', title: 'Child title' }, 'unknown');
  send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hidden' } }, 'unknown');
  await fixture.settleHost();
  assert.equal(app.getSession('s1').title, title);
  assert.deepEqual(kinds(app.getMessages('s1')), ['user']);
  assert.deepEqual(kinds(app.getMessages('unknown')), ['agent']);
});

test('a nested subagent is kept under the root session, its card where it was announced', async () => {
  const { fixture, send } = await running();
  launch(send);
  send(
    { sessionUpdate: 'subagent_update', sessionId: 'grandchild', title: 'Deeper', state: { state: 'running' } },
    'child',
  );
  await fixture.settleHost();
  assert.deepEqual(Object.keys(fixture.app.getRuntime('s1').subagents), ['child', 'grandchild']);
  assert.deepEqual(kinds(fixture.app.getMessages('child')), ['user', 'tool', 'subagent:grandchild']);
});

test('loading the root session again drops its subagents until the agent replays them', async () => {
  const { fixture, prompt, send } = await running();
  launch(send);
  fixture.reply(prompt, { answer: 'Done' });
  await fixture.settleHost();
  assert.ok(fixture.app.getRuntime('s1').subagents.child);

  const loading = fixture.app.retrySessionLoad('s1');
  assert.equal(fixture.app.getRuntime('s1').subagents, undefined);
  assert.equal(fixture.app.getMessages('child').length, 0);
  await fixture.settleHost();
  await loading;
  assert.equal(fixture.app.isSessionOpened('s1'), true);
});
