import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture } from './helpers/app-fixture.mjs';

const {
  getProcessSummary,
  getToolCommand,
  getToolStatus,
  groupTimelineMessages,
  reduceSessionEvent,
  extractDataImageAttachments,
  parseToolOutputs,
} = documentFixture().app;

const plain = (value) => JSON.parse(JSON.stringify(value));

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
  const diffContent = [{ type: 'diff', path: 'src/app.ts', oldText: 'old', newText: 'new' }];
  apply({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'check',
    rawInput: { command: 'pnpm run check --verbose' },
    content: diffContent,
    rawOutput: { exitCode: 0, stdout: 'All checks passed' },
  });
  assert.equal(getProcessSummary(group()), 'pnpm run check --verbose');
  const checkTool = messages.findLast((message) => message.type === 'tool' && message.data.toolCallId === 'check');
  assert.deepEqual(plain(checkTool.data.content), diffContent);
  assert.deepEqual(plain(checkTool.data.rawOutput), { exitCode: 0, stdout: 'All checks passed' });
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'check', status: 'completed' });
  assert.equal(getProcessSummary(group()), 'Thinking…');
});

test('parseToolOutputs extracts text, structured rawOutput, and ignores duplicates', () => {
  const toolData = {
    toolCallId: 't1',
    title: 'Run task',
    content: [
      { type: 'text', text: 'First line of stdout' },
      { type: 'content', content: { type: 'text', text: 'Second line of stdout' } },
    ],
    rawOutput: 'First line of stdout',
  };
  const parsed = parseToolOutputs(toolData);
  assert.deepEqual(plain(parsed.texts), ['First line of stdout', 'Second line of stdout']);
  assert.equal(parsed.raw, undefined);

  const structured = parseToolOutputs({
    toolCallId: 't2',
    title: 'Check files',
    rawOutput: { files: ['a.ts', 'b.ts'], count: 2 },
  });
  assert.deepEqual(plain(structured.texts), []);
  assert.deepEqual(plain(structured.raw), { files: ['a.ts', 'b.ts'], count: 2 });

  const fencedData = {
    toolCallId: 't3',
    title: 'Run bash',
    content: [{ type: 'text', text: '```console\n(Bash completed with no output)\n```' }],
    rawOutput: '(Bash completed with no output)',
  };
  const fencedParsed = parseToolOutputs(fencedData);
  assert.deepEqual(plain(fencedParsed.texts), ['```console\n(Bash completed with no output)\n```']);
  assert.equal(fencedParsed.raw, undefined);
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

test('empty agent text messages do not split process groups, but non-empty or attachment messages do', () => {
  const thought = { id: 'thought', type: 'thought', text: 'Thinking', pending: false };
  const tool1 = { id: 'tool-1', type: 'tool', data: { toolCallId: 'tool-1', title: 'Tool 1', status: 'completed' } };
  const tool2 = { id: 'tool-2', type: 'tool', data: { toolCallId: 'tool-2', title: 'Tool 2', status: 'completed' } };
  const emptyAgentMessage = { id: 'empty', role: 'agent', text: '\n\n' };
  const whitespaceAgentMessage = { id: 'ws', role: 'agent', text: '   ' };

  const mergedItems = groupTimelineMessages(
    [{ id: 'user', role: 'user', text: 'Question' }, thought, emptyAgentMessage, tool1, whitespaceAgentMessage, tool2],
    false,
  );

  assert.equal(mergedItems.length, 2);
  assert.equal(mergedItems[0].type, 'message');
  assert.equal(mergedItems[1].type, 'group');
  assert.equal(mergedItems[1].group.items.length, 3);
  assert.equal(getProcessSummary(mergedItems[1].group), '2 tool calls');

  const splitItems = groupTimelineMessages(
    [
      { id: 'user', role: 'user', text: 'Question' },
      thought,
      { id: 'real', role: 'agent', text: 'Here is what I found:' },
      tool1,
    ],
    false,
  );

  assert.equal(splitItems.length, 4);
  assert.equal(splitItems[1].type, 'group');
  assert.equal(splitItems[2].type, 'message');
  assert.equal(splitItems[3].type, 'group');

  const attachmentItems = groupTimelineMessages(
    [
      { id: 'user', role: 'user', text: 'Question' },
      thought,
      { id: 'attachment-msg', role: 'agent', text: '', attachments: [{ id: 'a1', kind: 'image', name: 'img' }] },
      tool1,
    ],
    false,
  );

  assert.equal(attachmentItems.length, 4);
  assert.equal(attachmentItems[1].type, 'group');
  assert.equal(attachmentItems[2].type, 'message');
  assert.equal(attachmentItems[3].type, 'group');
});

test('inline base64 images in message text become attachments instead of links', () => {
  const markdown = 'before\n![shot](data:image/png;base64,QUJD) after\n[titled](data:image/jpeg;base64,REVG)';
  const { attachments, markdown: rest } = extractDataImageAttachments(markdown);
  assert.equal(rest, 'before\n after\n');
  assert.equal(attachments.length, 2);
  assert.deepEqual(plain(attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }))), [
    { name: 'shot', mimeType: 'image/png', data: 'QUJD' },
    { name: 'titled', mimeType: 'image/jpeg', data: 'REVG' },
  ]);
  assert.deepEqual(plain(attachments.map(({ previewUrl }) => previewUrl)), [
    'data:image/png;base64,QUJD',
    'data:image/jpeg;base64,REVG',
  ]);
  assert.equal(extractDataImageAttachments('no images here').attachments.length, 0);
  assert.equal(extractDataImageAttachments('no images here').markdown, 'no images here');
  const cached = extractDataImageAttachments(markdown);
  assert.equal(cached.attachments, attachments);
  assert.equal(cached.attachments[0].id, attachments[0].id);
});
