import type { ChatMessage, TextMessage, ThoughtMessage, ToolMessage } from './types';

export type ProcessGroup = { id: string; items: (ThoughtMessage | ToolMessage)[]; pending: boolean };

type TimelineItem = { type: 'message'; message: TextMessage } | { type: 'group'; group: ProcessGroup };

export const groupTimelineMessages = (messages: ChatMessage[], sessionPending: boolean): TimelineItem[] => {
  const result: TimelineItem[] = [];
  let currentGroup: ProcessGroup | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;

    if ('type' in msg && (msg.type === 'thought' || msg.type === 'tool')) {
      const isMsgPending =
        (msg.type === 'thought' && (msg.pending || (isLast && sessionPending))) ||
        (msg.type === 'tool' &&
          (!msg.data.status || msg.data.status === 'pending' || msg.data.status === 'in_progress'));

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
