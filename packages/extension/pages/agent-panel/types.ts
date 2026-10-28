import type { Updater } from '@mantou/gem/lib/utils';
import type { PermissionRequest, SessionConfigOption } from 'agentdeck/agent/api';
import type { Attachment } from 'agentdeck/attachment/types';
import type { ToolCallData } from 'agentdeck/session/types';
import type { AgentDefaults, SessionRecord } from '../../shared/agent-session-store';

/** ACP `session/update` payload; fields depend on `sessionUpdate`. */
export type AcpUpdate = Partial<ToolCallData> & {
  sessionUpdate?: string;
  [key: string]: unknown;
};

export type PanelMessage =
  | { type?: undefined; role: 'user' | 'agent'; text: string; attachments?: Attachment[] }
  | { type: 'thought'; text: string; pending: boolean }
  | { type: 'tool'; data: AcpUpdate }
  /** Raw updates, only shown with `show-events`. */
  | { type: 'event'; data: AcpUpdate };

export type PromptPayload = { prompt: string; attachments: Attachment[] };

export type QueueItem = PromptPayload & { id: string };

/** Per-session view; the displayed one lives in the panel state, others in the runtime's cache. */
export type Pane = {
  messages: PanelMessage[];
  configOptions: SessionConfigOption[];
  cwd: string;
  queue: QueueItem[];
};

export type PanelState = Pane & {
  compact: boolean;
  /** Persisted local records. */
  sessions: SessionRecord[];
  /** At most one local session without an ACP session id; never persisted. */
  draftSession: SessionRecord | null;
  defaults: AgentDefaults;
  /** Unique local key of the displayed session. */
  sessionKey: string | null;
  /** Local session keys with a prompt in flight. */
  pendingIds: string[];
  /** Initial local state loading (whole page loader). */
  booting: boolean;
  /** Local session keys being created or loaded. */
  loadingIds: string[];
  /** Local session key being deleted. */
  deleting: string | null;
  /** Global errors (storage/delete/create), transient. */
  error: string;
  /** Per-session last error, shown when that session displays. */
  sessionErrors: Record<string, string>;
  home: string;
  newSessionOpen: boolean;
  settingsOpen: boolean;
  relayId: string;
  /** Per-session outstanding permission request: local key -> request. */
  permissions: Record<string, PermissionRequest>;
};

export type PanelStore = Updater<PanelState>;
