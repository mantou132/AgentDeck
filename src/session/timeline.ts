import type { ChatMessage, TextMessage, ThoughtMessage, ToolCallData, ToolMessage } from './types';

export type ProcessGroup = { id: string; items: (ThoughtMessage | ToolMessage)[]; pending: boolean };

type TimelineItem = { type: 'message'; message: TextMessage } | { type: 'group'; group: ProcessGroup };

export const toolStatusLabels = {
  pending: '等待中',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  ended: '已结束',
} as const;

export const getToolStatus = (tool: ToolCallData, live: boolean) => {
  const status = tool.status || 'pending';
  return !live && (status === 'pending' || status === 'in_progress') ? 'ended' : status;
};

export const getProcessSummary = (group: ProcessGroup) => {
  const tools = group.items.filter((item) => item.type === 'tool');
  if (!group.pending) return tools.length ? `${tools.length} 次工具调用` : '思考过程';
  const active = tools.findLast(
    (tool) => !tool.data.status || tool.data.status === 'pending' || tool.data.status === 'in_progress',
  );
  return active ? getToolCommand(active.data) : '正在思考…';
};

export const getToolCommand = ({ rawInput, title }: ToolCallData) => {
  if (typeof rawInput === 'string' && rawInput.trim()) return rawInput;
  if (rawInput && typeof rawInput === 'object') {
    const input = rawInput as { command?: unknown; cmd?: unknown };
    const command = input.command ?? input.cmd;
    if (typeof command === 'string' && command.trim()) return command;
  }
  return title || '工具调用';
};

export const groupTimelineMessages = (messages: ChatMessage[], sessionPending: boolean): TimelineItem[] => {
  const result: TimelineItem[] = [];
  let currentGroup: ProcessGroup | null = null;
  const lastUserIndex = messages.findLastIndex((message) => 'role' in message && message.role === 'user');

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;

    if ('type' in msg && (msg.type === 'thought' || msg.type === 'tool')) {
      const isMsgPending =
        sessionPending &&
        i > lastUserIndex &&
        ((msg.type === 'thought' && (msg.pending || isLast)) ||
          (msg.type === 'tool' &&
            (!msg.data.status || msg.data.status === 'pending' || msg.data.status === 'in_progress')));

      if (!currentGroup) {
        currentGroup = {
          id: `group-${msg.id}`,
          items: [msg],
          pending: Boolean(isMsgPending),
        };
        result.push({ type: 'group', group: currentGroup });
      } else {
        currentGroup.items.push(msg);
        if (isMsgPending) {
          currentGroup.pending = true;
        }
      }
    } else {
      currentGroup = null;
      result.push({ type: 'message', message: msg as TextMessage });
    }
  }

  return result;
};
