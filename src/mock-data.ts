import type { ChatMessage, DeckSession } from './session-store';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const DEFAULT_SESSION_ID = 'session-navigation';

export const mockSessions: DeckSession[] = [
  {
    id: DEFAULT_SESSION_ID,
    title: '重构移动端导航',
    agent: 'Codex',
    model: 'GPT-5.6',
    cwd: '~/agentdeck',
    updatedAt: minutesAgo(1),
  },
  {
    id: 'session-events',
    title: '检查 ACP 事件流',
    agent: 'Claude Code',
    model: 'Sonnet',
    cwd: '~/browser-mcp',
    updatedAt: minutesAgo(48),
  },
  {
    id: 'session-release',
    title: '整理移动端发布清单',
    agent: 'Codex',
    model: 'GPT-5.6',
    cwd: '~/agentdeck',
    updatedAt: minutesAgo(190),
  },
];

export const mockMessages: Record<string, ChatMessage[]> = {
  [DEFAULT_SESSION_ID]: [
    {
      id: 'message-user-1',
      role: 'user',
      text: '把会话列表和 session 拆成两个独立页面。启动时先显示列表，点开会话后再进入 session。',
      createdAt: minutesAgo(8),
    },
    {
      id: 'message-thought-1',
      type: 'thought',
      text: '先确认 Tap UI 的 Stack 行为，以及当前页面的安全区处理方式。',
      pending: false,
      createdAt: minutesAgo(7),
    },
    {
      id: 'message-tool-1',
      type: 'tool',
      data: {
        toolCallId: 'tool-read-stack',
        title: '读取 Stack 导航实现',
        kind: 'read',
        status: 'completed',
        rawInput: { path: 'node_modules/@mantou/tap-ui/elements/stack.d.ts' },
      },
      createdAt: minutesAgo(7),
    },
    {
      id: 'message-agent-1',
      role: 'agent',
      text: '导航已经拆开：会话列表是首页，点击条目后 session 才会入栈。左边缘滑动或顶部菜单按钮都会返回列表。',
      createdAt: minutesAgo(6),
    },
    {
      id: 'message-user-2',
      role: 'user',
      text: '消息区也要更像移动端 App，工具调用别太抢眼。',
      createdAt: minutesAgo(4),
    },
    {
      id: 'message-tool-2',
      type: 'tool',
      data: {
        toolCallId: 'tool-check',
        title: '校验前端类型',
        kind: 'shell',
        status: 'completed',
        rawInput: { command: 'pnpm run check' },
      },
      createdAt: minutesAgo(3),
    },
    {
      id: 'message-agent-2',
      role: 'agent',
      text: '已调整为移动端阅读节奏：用户消息保持短气泡，Agent 回复占完整内容宽度；思考和工具调用折叠成低对比度状态卡，正文始终是视觉主角。',
      createdAt: minutesAgo(2),
    },
  ],
  'session-events': [
    {
      id: 'events-user',
      role: 'user',
      text: '确认 tool_call_update 是否会覆盖原来的工具状态。',
      createdAt: minutesAgo(51),
    },
    {
      id: 'events-tool',
      type: 'tool',
      data: {
        toolCallId: 'tool-event-test',
        title: '运行事件归并测试',
        kind: 'test',
        status: 'completed',
        rawInput: { file: 'agent-panel-runtime.test.mjs' },
      },
      createdAt: minutesAgo(49),
    },
    {
      id: 'events-agent',
      role: 'agent',
      text: '确认：更新会按 toolCallId 合并到原记录，列表位置不变，最终状态显示为 completed。',
      createdAt: minutesAgo(48),
    },
  ],
  'session-release': [
    {
      id: 'release-agent',
      role: 'agent',
      text: '发布清单已准备好。接下来需要确认应用标识、签名团队和真实 ACP WebSocket 地址。',
      createdAt: minutesAgo(190),
    },
  ],
};
