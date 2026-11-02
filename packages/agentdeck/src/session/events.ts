import type { AvailableCommand, SessionConfigOption, SessionEvent } from '../agent/api';
import { imageAttachment } from '../attachment/message';
import { i18n } from '../i18n';
import { withCurrentMode } from './config-options';
import type {
  ChatMessage,
  DeckSession,
  SessionOptions,
  Subagent,
  SubagentState,
  TextMessage,
  ToolCallContent,
  ToolCallData,
  ToolCallStatus,
  ToolMessage,
} from './types';

type SessionEventContext = {
  agent: string;
  streaming: boolean;
  options?: SessionOptions;
  /** Set when these are the messages of subagent session `subagentId`. */
  subagentId?: string;
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

export const appendContent = (
  messages: ChatMessage[],
  role: 'user' | 'agent',
  text: string,
  streaming: boolean,
  messageId?: string,
) => {
  const next = messages.slice();
  const last = next.at(-1);
  const patch = messageId ? { messageId } : {};
  if (last && 'role' in last && last.role === role && last.streaming === streaming) {
    next[next.length - 1] = { ...last, text: last.text + text, ...patch };
  } else {
    next.push({ id: crypto.randomUUID(), role, text, streaming, ...patch });
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
  const attachment = imageAttachment(data, mimeType, i18n.get('attachment.imageDefaultName'));
  const next = messages.slice();
  const last = next.at(-1);
  if (last && 'role' in last && last.role === role && last.streaming === streaming) {
    next[next.length - 1] = { ...last, attachments: [...(last.attachments ?? []), attachment] };
  } else {
    next.push({ id: crypto.randomUUID(), role, text: '', attachments: [attachment], streaming });
  }
  return next;
};

// When codex-acp replays history imported from other agents, tool calls and results are output as text markers; restore them as tool messages to collapse into process groups
const externalToolPattern =
  /\[external_agent_tool_call: ([^\]\n]+)\]\n?([\s\S]*?)\n?\[\/external_agent_tool_call\]|\[external_agent_tool_result(: error)?\]\n?([\s\S]*?)\n?\[\/external_agent_tool_result\]/g;
const externalToolPrefix = 'external-';

const parseExternalToolInput = (body: string): unknown => {
  const input: Record<string, string> = {};
  let key = '';
  for (const line of body.split('\n')) {
    const match = /^(\w+):(?: (.*))?$/.exec(line);
    if (match) {
      key = match[1];
      input[key] = match[2] ?? '';
    } else if (key) {
      input[key] += `\n${line}`;
    }
  }
  if (Object.keys(input).length !== 1 || input.input === undefined) return input;
  try {
    return JSON.parse(input.input);
  } catch {
    return input.input;
  }
};

const extractExternalTools = (messages: ChatMessage[]) => {
  const last = messages.at(-1) as TextMessage;
  if (!last.text.includes('[/external_agent_tool_')) return messages;
  const next = messages.slice(0, -1);
  const pushText = (text: string) => {
    if (next.length === messages.length - 1 && (text.trim() || last.attachments?.length)) {
      next.push({ ...last, text });
    } else if (text.trim()) {
      next.push({ id: crypto.randomUUID(), role: last.role, text, streaming: last.streaming });
    }
  };
  let rest = 0;
  for (const match of last.text.matchAll(externalToolPattern)) {
    pushText(last.text.slice(rest, match.index));
    rest = match.index + match[0].length;
    const [, name, body, error, output] = match;
    if (name) {
      const rawInput = parseExternalToolInput(body);
      const file = rawInput && typeof rawInput === 'object' && 'file' in rawInput ? rawInput.file : '';
      next.push({
        id: crypto.randomUUID(),
        type: 'tool',
        data: {
          toolCallId: `${externalToolPrefix}${crypto.randomUUID()}`,
          title: [name, file].join(' ').trim(),
          rawInput,
        },
      });
      continue;
    }
    const index = next.findLastIndex(
      (message) =>
        'type' in message && message.type === 'tool' && message.data.toolCallId.startsWith(externalToolPrefix),
    );
    const tool = next[index] as ToolMessage | undefined;
    if (!tool || tool.data.status) continue;
    next[index] = {
      ...tool,
      data: {
        ...tool.data,
        status: error ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: output } }],
      },
    };
  }
  pushText(last.text.slice(rest));
  return next;
};

export type EventReduction = {
  messages?: ChatMessage[];
  sessionPatch?: Partial<DeckSession>;
  optionsPatch?: Partial<SessionOptions>;
  commands?: AvailableCommand[];
  /** A `subagent_update` announcing or patching a subagent session. */
  subagent?: { sessionId: string; patch: Partial<Subagent> };
};

const getSubagentState = (value: unknown): SubagentState | undefined => {
  if (!value || typeof value !== 'object' || !('state' in value) || typeof value.state !== 'string') return;
  const stopReason = 'stopReason' in value && typeof value.stopReason === 'string' ? value.stopReason : undefined;
  return { state: value.state, stopReason };
};

/** Optional fields are nullable patches: missing keeps the value, `null` clears it. */
const getSubagentPatch = (update: Record<string, unknown>): Partial<Subagent> => {
  const patch: Partial<Subagent> = {};
  if ('title' in update) patch.title = typeof update.title === 'string' ? update.title : undefined;
  if ('description' in update) {
    patch.description = typeof update.description === 'string' ? update.description : undefined;
  }
  if ('state' in update) patch.state = getSubagentState(update.state);
  if ('capabilities' in update) {
    const capabilities = update.capabilities as { cancel?: unknown } | null;
    patch.cancellable = Boolean(capabilities?.cancel);
  }
  return patch;
};

const getContentText = (content: unknown) =>
  (Array.isArray(content) ? content : [content])
    .map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
    .join('');

const getToolContent = (update: Record<string, unknown>) => {
  if (!Array.isArray(update.content)) return {};
  return {
    content: update.content.filter((item): item is ToolCallContent => Boolean(item) && typeof item === 'object'),
  };
};

export const reduceSessionEvent = (
  current: ChatMessage[],
  event: SessionEvent,
  context: SessionEventContext,
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
    if (agent === 'claude-acp' && role === 'user' && content.text.trim() === '[Request interrupted by user]') {
      return messages !== current ? { messages } : null;
    }
    const messageId = role === 'agent' && typeof update.messageId === 'string' ? update.messageId : undefined;
    const next = appendContent(messages, role, content.text, streaming, messageId);
    return { messages: agent === 'codex-acp' && role === 'agent' ? extractExternalTools(next) : next };
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
            title: typeof update.title === 'string' ? update.title : i18n.get('timeline.toolCall'),
            ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
            ...(typeof update.status === 'string' ? { status: update.status as ToolCallStatus } : {}),
            ...('rawInput' in update ? { rawInput: update.rawInput } : {}),
            ...('rawOutput' in update ? { rawOutput: update.rawOutput } : {}),
            ...getToolContent(update),
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
      ...('rawOutput' in update ? { rawOutput: update.rawOutput } : {}),
      ...getToolContent(update),
    };
    if (index < 0) {
      next.push({
        id: crypto.randomUUID(),
        type: 'tool',
        data: { toolCallId: update.toolCallId, title: patch.title ?? i18n.get('timeline.toolCall'), ...patch },
      });
    } else {
      const message = next[index] as ToolMessage;
      next[index] = { ...message, data: { ...message.data, ...patch } };
    }
    return { messages: next };
  }

  if (sessionUpdate === 'subagent_update' && typeof update.sessionId === 'string') {
    const { sessionId } = update;
    // The card stays where the subagent was first announced.
    const known = messages.some(
      (message) => 'type' in message && message.type === 'subagent' && message.sessionId === sessionId,
    );
    const next: ChatMessage[] = known
      ? messages
      : [...messages, { id: crypto.randomUUID(), type: 'subagent', sessionId }];
    return {
      ...(next !== current ? { messages: next } : {}),
      subagent: { sessionId, patch: getSubagentPatch(update) },
    };
  }

  // A subagent shows the instructions it received; a parent reads a subagent's reply in its card.
  if (sessionUpdate === 'session_message' && typeof update.messageId === 'string') {
    const recipient = typeof update.recipientSessionId === 'string' ? update.recipientSessionId : undefined;
    if (!context.subagentId || (recipient && recipient !== context.subagentId)) {
      return messages !== current ? { messages } : null;
    }
    const next = messages.slice();
    const index = next.findIndex((message) => 'role' in message && message.sessionMessageId === update.messageId);
    if (index >= 0) {
      if (!('content' in update)) return messages !== current ? { messages } : null;
      next[index] = { ...(next[index] as TextMessage), text: getContentText(update.content) };
    } else {
      next.push({
        id: crypto.randomUUID(),
        role: 'user',
        text: getContentText(update.content),
        sessionMessageId: update.messageId,
      });
    }
    return { messages: next };
  }

  if (sessionUpdate === 'session_message_chunk' && typeof update.messageId === 'string') {
    const index = messages.findIndex((message) => 'role' in message && message.sessionMessageId === update.messageId);
    if (index < 0) return messages !== current ? { messages } : null;
    const next = messages.slice();
    const message = next[index] as TextMessage;
    next[index] = { ...message, text: message.text + getContentText(update.content) };
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
    return { optionsPatch: withCurrentMode(options ?? {}, update.currentModeId) };
  }

  if (sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
    return { optionsPatch: { configOptions: update.configOptions as SessionConfigOption[] } };
  }

  // A subagent cannot be prompted, so its commands are never offered.
  if (sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands) && !context.subagentId) {
    return { commands: update.availableCommands as AvailableCommand[] };
  }

  return null;
};
