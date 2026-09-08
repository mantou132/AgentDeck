import { i18n } from '../i18n';
import type { Attachment, ChatMessage, TextMessage, ThoughtMessage, ToolCallData, ToolMessage } from './types';

export type ProcessGroup = { id: string; items: (ThoughtMessage | ToolMessage)[]; pending: boolean };

type TimelineItem = { type: 'message'; message: TextMessage } | { type: 'group'; group: ProcessGroup };

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'ended';

export const getToolStatus = (tool: ToolCallData, live: boolean) => {
  const status = tool.status || 'pending';
  return !live && (status === 'pending' || status === 'in_progress') ? 'ended' : status;
};

export const getProcessSummary = (group: ProcessGroup): string => {
  const tools = group.items.filter((item) => item.type === 'tool');
  if (!group.pending) {
    return tools.length
      ? (i18n.get('timeline.toolCalls', String(tools.length)) as unknown as string)
      : i18n.get('timeline.thought');
  }
  const active = tools.findLast(
    (tool) => !tool.data.status || tool.data.status === 'pending' || tool.data.status === 'in_progress',
  );
  return active ? getToolCommand(active.data) : i18n.get('timeline.thinking');
};

export const getToolCommand = ({ rawInput, title }: ToolCallData) => {
  if (typeof rawInput === 'string' && rawInput.trim()) return rawInput;
  if (rawInput && typeof rawInput === 'object') {
    const input = rawInput as { command?: unknown; cmd?: unknown };
    const command = input.command ?? input.cmd;
    if (typeof command === 'string' && command.trim()) return command;
  }
  return title || i18n.get('timeline.toolCall');
};

// 历史消息里的内联 base64 图片不再渲染为链接，还原成消息附件展示
const dataImageLinkPattern = /!?\[([^\]\n]*)\]\((data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)\)/gi;

export const extractDataImageAttachments = (text: string): { attachments: Attachment[]; markdown: string } => {
  const attachments: Attachment[] = [];
  const markdown = text.replace(dataImageLinkPattern, (_, name: string, previewUrl: string) => {
    const [header, data = ''] = previewUrl.split(',');
    attachments.push({
      id: crypto.randomUUID(),
      kind: 'image',
      name: name || i18n.get('attachment.imageDefaultName'),
      mimeType: /^data:([^;]+);/.exec(header)?.[1] || 'image/png',
      data,
      previewUrl,
    });
    return '';
  });
  return { attachments, markdown };
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
