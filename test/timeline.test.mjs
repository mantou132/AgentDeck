import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture } from './helpers/app-fixture.mjs';

const { getProcessSummary, getToolCommand, getToolStatus, groupTimelineMessages, reduceSessionEvent } =
  documentFixture().app;

test('tool summaries show shell commands and fall back to the reported tool title', () => {
  const tool = { toolCallId: 'tool', title: 'Execute command' };
  assert.equal(getToolCommand({ ...tool, rawInput: { command: 'pnpm run check' } }), 'pnpm run check');
  assert.equal(getToolCommand({ ...tool, rawInput: { cmd: 'rg permission src' } }), 'rg permission src');
  assert.equal(getToolCommand({ ...tool, rawInput: 'git status --short' }), 'git status --short');
  assert.equal(
    getToolCommand({ ...tool, title: 'Read src/pages/session.ts', rawInput: { path: 'src/pages/session.ts' } }),
    'Read src/pages/session.ts',
  );
});

test('live summaries select an unfinished tool even after another tool or thought arrives', () => {
  let messages = [{ id: 'user', role: 'user', text: 'Review this project' }];
  const apply = (update) => {
    messages = reduceSessionEvent(
      messages,
      { event: 'session_update', update },
      { agent: 'codex', streaming: true },
    ).messages;
  };
  apply({
    sessionUpdate: 'tool_call',
    toolCallId: 'check',
    title: 'Execute command',
    status: 'in_progress',
    rawInput: { command: 'pnpm run check' },
  });
  apply({
    sessionUpdate: 'tool_call',
    toolCallId: 'status',
    title: 'Execute command',
    status: 'completed',
    rawInput: { cmd: 'git status --short' },
  });
  apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Waiting for the check' } });
  const group = () => groupTimelineMessages(messages, true).find((item) => item.type === 'group').group;
  assert.equal(getProcessSummary(group()), 'pnpm run check');
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'check', rawInput: { command: 'pnpm run check --verbose' } });
  assert.equal(getProcessSummary(group()), 'pnpm run check --verbose');
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'check', status: 'completed' });
  assert.equal(getProcessSummary(group()), 'Thinking…');
});

test('finished history uses a general summary instead of an old command', () => {
  const thought = { id: 'thought', type: 'thought', text: 'Thinking', pending: false };
  const group = {
    id: 'group',
    pending: false,
    items: [
      { id: 'old', type: 'tool', data: { toolCallId: 'old', title: 'old command', status: 'in_progress' } },
      { id: 'last', type: 'tool', data: { toolCallId: 'last', title: 'last command', status: 'completed' } },
      thought,
    ],
  };
  assert.equal(getProcessSummary(group), '2 tool calls');
  assert.equal(getProcessSummary({ ...group, items: [thought] }), 'Thought process');
  assert.equal(getProcessSummary({ ...group, pending: true, items: [thought] }), 'Thinking…');
});

test('starting another task does not revive unfinished tools from an earlier turn', () => {
  const oldTool = { toolCallId: 'old', title: 'Old command', status: 'in_progress' };
  const newTool = { toolCallId: 'new', title: 'New command', status: 'in_progress' };
  const messages = [
    { id: 'first', role: 'user', text: 'First task' },
    { id: 'old', type: 'tool', data: oldTool },
    { id: 'second', role: 'user', text: 'Second task' },
    { id: 'new', type: 'tool', data: newTool },
  ];
  const groups = groupTimelineMessages(messages, true)
    .filter((item) => item.type === 'group')
    .map((item) => item.group);
  assert.equal(groups[0].pending, false);
  assert.equal(getToolStatus(oldTool, groups[0].pending), 'ended');
  assert.equal(getProcessSummary(groups[0]), '1 tool calls');
  assert.equal(groups[1].pending, true);
  assert.equal(getToolStatus(newTool, groups[1].pending), 'in_progress');
  assert.equal(getProcessSummary(groups[1]), 'New command');
  assert.ok(
    groupTimelineMessages(messages, false)
      .filter((item) => item.type === 'group')
      .every((item) => !item.group.pending),
  );
  assert.equal(getToolStatus({ ...oldTool, status: 'failed' }, false), 'failed');
});
