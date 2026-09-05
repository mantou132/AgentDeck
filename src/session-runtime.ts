import { isRelayId } from 'relay-client-ts';
import type { LoadedSession, RemoteAgent, RemoteSession, SessionEvent } from './agent-api';

export type AppSettings = {
  relayId: string;
  agent: string;
};

export type DeckSession = RemoteSession & {
  agent: string;
  draft?: boolean;
};

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallData = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
};

export type Attachment = {
  id: string;
  name: string;
  pasteReference?: number;
  marker?: string;
} & ({ kind: 'image'; data: string; mimeType: string; previewUrl: string } | { kind: 'text'; text: string });

export type TextMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  attachments?: Attachment[];
  streaming?: boolean;
  failed?: boolean;
};

export type ThoughtMessage = {
  id: string;
  type: 'thought';
  text: string;
  pending: boolean;
};

export type ToolMessage = {
  id: string;
  type: 'tool';
  data: ToolCallData;
};

export type ChatMessage = TextMessage | ThoughtMessage | ToolMessage;

export type SessionOptions = Pick<LoadedSession, 'modes' | 'configOptions'>;

export const SETTINGS_KEY = 'agentdeck.settings.v1';
export const DEVICE_ID_KEY = 'agentdeck.device_id.v1';
export const RESET_PENDING_KEY = 'agentdeck.reset_pending.v1';
export const RELAY_URL =
  process.env.NODE_ENV === 'development' ? 'ws://192.168.77.137:39371/ws' : 'wss://agent-deck.xianqiao.wang/ws';

export const fallbackAgents: RemoteAgent[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'pi', name: 'pi' },
];

export const readSettings = (): AppSettings => {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') as Partial<AppSettings> | null;
    const relayId = typeof value?.relayId === 'string' && isRelayId(value.relayId) ? value.relayId : '';
    return {
      relayId,
      agent: typeof value?.agent === 'string' && value.agent ? value.agent : 'codex',
    };
  } catch {
    return { relayId: '', agent: 'codex' };
  }
};

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

export const optionLabel = (option: unknown) => {
  if (!option || typeof option !== 'object') return '';
  const record = option as {
    id?: unknown;
    name?: unknown;
    currentValue?: unknown;
    options?: { value?: unknown; name?: unknown }[];
  };
  if (typeof record.currentValue !== 'string') return '';
  const selected = record.options?.find((item) => item.value === record.currentValue);
  const name = typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : '';
  const value = typeof selected?.name === 'string' ? selected.name : record.currentValue;
  return name ? `${name}: ${value}` : value;
};

export const formatOptionLabels = (options?: SessionOptions) => {
  const labels = (options?.configOptions ?? []).map(optionLabel).filter(Boolean);
  if (labels.length) return labels;
  if (options?.modes && typeof options.modes === 'object') {
    const modes = options.modes as {
      currentModeId?: unknown;
      availableModes?: { id?: unknown; name?: unknown }[];
    };
    if (typeof modes.currentModeId === 'string') {
      const selected = modes.availableModes?.find((mode) => mode.id === modes.currentModeId);
      return [typeof selected?.name === 'string' ? selected.name : modes.currentModeId];
    }
  }
  return ['ACP 默认值'];
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
