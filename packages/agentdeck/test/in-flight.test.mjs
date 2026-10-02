import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

test('app restart restores in-flight pending session and seamlessly receives remaining stream', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession('s1');

  // Send a prompt
  assert.equal(fixture.app.sendPrompt('s1', 'Write a hello world script'), true);
  await tick();

  const promptRequest = fixture.requests.find((r) => r.payload.method === 'agent_prompt');
  assert.ok(promptRequest, 'prompt request sent');
  const promptId = promptRequest.payload.id;

  // Stream partial response from agent
  fixture.deliver({
    id: promptId,
    peerId: 1,
    event: {
      event: 'session_update',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking...' },
      },
    },
  });
  await tick();

  fixture.deliver({
    id: promptId,
    peerId: 1,
    event: {
      event: 'session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Here is the' },
      },
    },
  });
  await tick();

  const currentMessages = fixture.app.agentdeckStore.messagesBySession.s1;
  assert.equal(currentMessages.length, 3);
  assert.equal(currentMessages[2].text, 'Here is the');
  assert.equal(fixture.app.agentdeckStore.pendingSessionIds.includes('s1'), true);

  // Simulate App sudden restart / kill (without reset)
  const fresh = documentFixture(fixture);
  await fresh.connect();

  // 1. Verify ack_head is false (does not abandon Relay stream backlog)
  assert.notEqual(new URL(fresh.sockets[0].url).searchParams.get('ack_head'), 'true');

  // 2. Verify state was restored
  assert.equal(fresh.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
  assert.equal(fresh.app.agentdeckStore.loadedSessionIds.includes('s1'), true);
  const restoredMessages = fresh.app.agentdeckStore.messagesBySession.s1;
  assert.ok(restoredMessages, 'restored messages exist');
  assert.equal(restoredMessages.length, 3);
  assert.equal(restoredMessages[2].text, 'Here is the');

  // 3. User navigates into session: ensureSessionLoaded must NOT close remote active session
  const requestsBefore = fresh.requests.length;
  await fresh.app.ensureSessionLoaded('s1');
  const closeRequests = fresh.requests.slice(requestsBefore).filter((r) => r.payload.method === 'agent_session_close');
  assert.equal(closeRequests.length, 0, 'did not send close_session to active pending session');

  // 4. Relay replays and pushes remaining stream chunks
  fresh.deliver({
    id: promptId,
    peerId: 1,
    event: {
      event: 'session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' script:\nprint("Hello, World!")' },
      },
    },
  });
  await tick();

  const streamingMessages = fresh.app.agentdeckStore.messagesBySession.s1;
  assert.equal(streamingMessages[2].text, 'Here is the script:\nprint("Hello, World!")');

  // 5. Turn completes
  fresh.reply(promptRequest, { answer: 'Here is the script:\nprint("Hello, World!")' });
  await tick();

  assert.equal(fresh.app.agentdeckStore.pendingSessionIds.includes('s1'), false);
  const finalMessages = fresh.app.agentdeckStore.messagesBySession.s1;
  assert.equal(finalMessages[2].text, 'Here is the script:\nprint("Hello, World!")');

  // 6. Verify in-flight is purged after completion (Zero-bloat)
  const restartAgain = documentFixture(fresh);
  await restartAgain.connect();
  assert.equal(restartAgain.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('app restart reconciles in-flight session with remote list, keeping the active session group at the top', async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession('s1');

  // Send a prompt to enter in-flight status
  assert.equal(fixture.app.sendPrompt('s1', 'Do something'), true);
  await tick();

  // Simulate App restart
  const fresh = documentFixture(fixture);
  // Hold session list request so we can verify initial display state
  fresh.heldMethods.add('agent_session_list');
  await fresh.connect();

  // Before remote session list arrives, sessionsLoaded remains false (skeleton displays cleanly)
  assert.equal(fresh.app.agentdeckStore.sessionsLoaded, false);

  // Deliver remote session list containing multiple older projects
  const listReq = fresh.requests.find((r) => r.payload.method === 'agent_session_list');
  assert.ok(listReq, 'session list request was sent');
  fresh.reply(listReq, {
    sessions: [
      {
        sessionId: 'old-1',
        cwd: '/projects/old-1',
        agent: 'codex',
        title: 'Old 1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        sessionId: 'old-2',
        cwd: '/projects/old-2',
        agent: 'codex',
        title: 'Old 2',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  });
  await tick();

  assert.equal(fresh.app.agentdeckStore.sessionsLoaded, true);
  const groups = fresh.app.agentdeckStore.sessionGroups;
  // The in-flight session s1 (cwd: '/tmp') must be reconciled and ordered at the top!
  assert.ok(groups.length >= 2, 'contains both active and remote groups');
  assert.equal(groups[0].cwd, '/tmp', 'active in-flight project group is at the top');
  assert.equal(
    groups[0].sessions.some((s) => s.sessionId === 's1'),
    true,
    'contains the in-flight session',
  );
});

const restartWithLostReply = async () => {
  const fixture = documentFixture();
  await fixture.connect();
  await fixture.openSession();
  assert.equal(fixture.app.sendPrompt('s1', 'Long task'), true);
  await tick();
  const promptRequest = fixture.requests.find((r) => r.payload.method === 'agent_prompt');
  // The final reply expired on the Relay while the App was away.
  const fresh = documentFixture(fixture);
  await fresh.connect();
  const query = fresh.requests.find((r) => r.payload.method === 'agent_prompts_running');
  assert.ok(query, 'queries running prompts after connecting');
  return { fresh, promptRequest, query };
};

test('a restored turn the host no longer runs is settled and reloaded from history', async () => {
  const { fresh, promptRequest, query } = await restartWithLostReply();
  const requestsBefore = fresh.requests.length;
  fresh.reply(query, { sessions: [] });
  await fresh.settleHost();

  const store = fresh.app.agentdeckStore;
  assert.equal(store.pendingSessionIds.includes('s1'), false);
  assert.ok(store.unreadSessionIds.includes('s1'));
  assert.ok(store.loadedSessionIds.includes('s1'));
  const methods = fresh.requests.slice(requestsBefore).map((r) => r.payload.method);
  assert.deepEqual(
    methods.filter((m) => m === 'agent_session_close' || m === 'agent_session_load'),
    ['agent_session_close', 'agent_session_load'],
  );

  // A reply that was still on its way must not land on the reloaded timeline.
  fresh.reply(promptRequest, { answer: 'Late answer' });
  await tick();
  assert.equal(store.messagesBySession.s1.length, 0);

  const restartAgain = documentFixture(fresh);
  await restartAgain.connect();
  assert.equal(restartAgain.app.agentdeckStore.pendingSessionIds.length, 0);
});

test('a restored turn the host still runs keeps waiting for its reply', async () => {
  const { fresh, promptRequest, query } = await restartWithLostReply();
  fresh.reply(query, { sessions: [{ agent: 'codex', sessionId: 's1' }] });
  await fresh.settleHost();
  assert.ok(fresh.app.agentdeckStore.pendingSessionIds.includes('s1'));

  fresh.reply(promptRequest, { answer: 'Done' });
  await tick();
  assert.equal(fresh.app.agentdeckStore.pendingSessionIds.includes('s1'), false);
  assert.ok(fresh.app.agentdeckStore.unreadSessionIds.includes('s1'));
});
