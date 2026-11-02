import type { LoadedSession, RemoteSession } from '../agent/api';
import type { Attachment } from '../attachment/types';

export type DeckSession = RemoteSession & {
  agent: string;
  /** Local session awaiting its first remote create request. */
  pendingCreation?: boolean;
};

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallContent = Record<string, unknown> & { type?: string };

export type ToolCallData = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
};

export type TextMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** ACP id of the latest agent message merged into this one; a fork point for the next user message. */
  messageId?: string;
  attachments?: Attachment[];
  /** Sent from voice chat: the agent is asked for a spoken summary. */
  voiceChat?: boolean;
  /** ACP `session_message` id: a message from the parent session to this subagent session. */
  sessionMessageId?: string;
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

/** Where subagent `sessionId` was first announced; the timeline shows its card here. */
export type SubagentMessage = {
  id: string;
  type: 'subagent';
  sessionId: string;
};

export type ChatMessage = TextMessage | ThoughtMessage | ToolMessage | SubagentMessage;

/** Current work of a subagent (ACP Subagent Sessions RFD); unknown until the agent reports it. */
export type SubagentState = {
  state: 'running' | 'requires_action' | 'idle' | 'unknown' | (string & {});
  stopReason?: string | null;
};

/** A subagent session as `subagent_update` announced it; nested ones are kept under the root session too. */
export type Subagent = {
  title?: string;
  description?: string;
  state?: SubagentState;
  /** The agent allows cancelling its current work. */
  cancellable?: boolean;
};

export type SessionOptions = Pick<LoadedSession, 'modes' | 'configOptions'>;
