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
