import type { SessionEvent } from '../agent/api';
import type {
  Attachment,
  ChatMessage,
  DeckSession,
  SessionOptions,
  ToolCallData,
  ToolCallStatus,
  ToolMessage,
} from './types';

export const completeThought = (messages: ChatMessage[]) => {
  const last = messages.at(-1);
  if (!last || !('type' in last) || last.type !== 'thought' || !last.pending) return messages;
  const next = messages.slice();
  next[next.length - 1] = { ...last, pending: false };
  return next;
};

export const finishStreaming = (messages: ChatMessage[]) =>
  completeThought(messages).map((message) =>
    'role' in message && message.streaming ? { ...message, streaming: false } : message,
  );

export const appendContent = (messages: ChatMessage[], role: 'user' | 'agent', text: string, streaming: boolean) => {
  const next = messages.slice();
  const last = next.at(-1);
  if (last && 'role' in last && last.role === role && last.streaming === streaming) {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ id: crypto.randomUUID(), role, text, streaming });
  }
  return next;
};

export const appendImage = (
  messages: ChatMessage[],
  role: 'user' | 'agent',
  content: Record<string, unknown>,
  streaming: boolean,
) => {
  const data = typeof content.data === 'string' ? content.data : '';
  if (!data) return messages;
  const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'image/png';
  const attachment: Attachment = {
    id: crypto.randomUUID(),
    kind: 'image',
    name: '图片',
    data,
    mimeType,
    previewUrl: `data:${mimeType};base64,${data}`,
  };
  const next = messages.slice();
  const last = next.at(-1);
  if (last && 'role' in last && last.role === role && last.streaming === streaming) {
    next[next.length - 1] = { ...last, attachments: [...(last.attachments ?? []), attachment] };
  } else {
    next.push({ id: crypto.randomUUID(), role, text: '', attachments: [attachment], streaming });
  }
  return next;
};

export type EventReduction = {
  messages?: ChatMessage[];
  sessionPatch?: Partial<DeckSession>;
  optionsPatch?: Partial<SessionOptions>;
};

export const reduceSessionEvent = (
  current: ChatMessage[],
  event: SessionEvent,
  context: {
    agent: string;
    streaming: boolean;
    options?: SessionOptions;
  },
): EventReduction | null => {
  if (event.event === 'stop') {
    return { messages: finishStreaming(current) };
  }

  const update = event.update;
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  const thoughtChunk = sessionUpdate === 'agent_thought_chunk';
  const messages = thoughtChunk ? current : completeThought(current);
  const { streaming, agent, options } = context;
  const content =
    update.content && typeof update.content === 'object' ? (update.content as Record<string, unknown>) : {};
  const role =
    sessionUpdate === 'agent_message_chunk' ? 'agent' : sessionUpdate === 'user_message_chunk' ? 'user' : undefined;

  if (role && content.type === 'text' && typeof content.text === 'string') {
    if (agent === 'claude' && role === 'user' && content.text.trim() === '[Request interrupted by user]') {
      return messages !== current ? { messages } : null;
    }
    return { messages: appendContent(messages, role, content.text, streaming) };
  }

  if (role && content.type === 'image') {
    return { messages: appendImage(messages, role, content, streaming) };
  }

  if (thoughtChunk && content.type === 'text' && typeof content.text === 'string') {
    const next = messages.slice();
    const last = next.at(-1);
    if (last && 'type' in last && last.type === 'thought') {
      next[next.length - 1] = { ...last, text: last.text + content.text, pending: true };
    } else {
      next.push({ id: crypto.randomUUID(), type: 'thought', text: content.text, pending: true });
    }
    return { messages: next };
  }

  if (sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') {
    return {
      messages: [
        ...messages,
        {
          id: crypto.randomUUID(),
          type: 'tool',
          data: {
            toolCallId: update.toolCallId,
            title: typeof update.title === 'string' ? update.title : '工具调用',
            ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
            ...(typeof update.status === 'string' ? { status: update.status as ToolCallStatus } : {}),
            ...('rawInput' in update ? { rawInput: update.rawInput } : {}),
          },
        },
      ],
    };
  }

  if (sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string') {
    const next = messages.slice();
    const index = next.findLastIndex(
      (message) => 'type' in message && message.type === 'tool' && message.data.toolCallId === update.toolCallId,
    );
    const patch: Partial<ToolCallData> = {
      ...(typeof update.title === 'string' ? { title: update.title } : {}),
      ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
      ...(typeof update.status === 'string' ? { status: update.status as ToolCallStatus } : {}),
      ...('rawInput' in update ? { rawInput: update.rawInput } : {}),
    };
    if (index < 0) {
      next.push({
        id: crypto.randomUUID(),
        type: 'tool',
        data: { toolCallId: update.toolCallId, title: patch.title ?? '工具调用', ...patch },
      });
    } else {
      const message = next[index] as ToolMessage;
      next[index] = { ...message, data: { ...message.data, ...patch } };
    }
    return { messages: next };
  }

  if (sessionUpdate === 'session_info_update') {
    const sessionPatch: Partial<DeckSession> = {
      ...(typeof update.title === 'string' && update.title ? { title: update.title } : {}),
      ...(typeof update.updatedAt === 'string' && update.updatedAt ? { updatedAt: update.updatedAt } : {}),
    };
    return Object.keys(sessionPatch).length ? { sessionPatch } : null;
  }

  if (sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
    const configOptions = options?.configOptions ?? [];
    return {
      optionsPatch: {
        configOptions: configOptions.map((option) => {
          if (!option || typeof option !== 'object' || (option as { id?: unknown }).id !== 'mode') return option;
          return { ...(option as object), currentValue: update.currentModeId };
        }),
      },
    };
  }

  if (sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
    return { optionsPatch: { configOptions: update.configOptions } };
  }

  return null;
};
