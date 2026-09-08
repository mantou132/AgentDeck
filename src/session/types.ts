import type { LoadedSession, RemoteSession } from '../agent/api';

export type DeckSession = RemoteSession & {
  agent: string;
  draft?: boolean;
};

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallContent = Record<string, unknown> & { type?: string };

export type ToolCallData = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
  content?: ToolCallContent[];
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
