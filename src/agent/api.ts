import { i18n } from '../i18n';
import type { RpcId, RpcMessage } from './rpc';
import { RpcPeer } from './rpc';

export type RemoteFile = { path: string } & (
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
);

export type BrowseEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type FileBrowseResult = {
  path: string;
  home?: string;
  entries: BrowseEntry[];
};

export type FileBrowseOptions = {
  cwd?: string;
  type?: 'all' | 'directory' | 'file';
  limit?: number;
};

export type PromptAttachment = { type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string };

export type RemoteSession = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  additionalDirectories?: string[];
};

export type SessionEvent =
  | { event: 'session_update'; update: Record<string, unknown> }
  | { event: 'stop'; stop_reason?: string };

export type SessionModes = {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string | null }[];
};

export type ConfigChoice = { value: string; name: string; description?: string | null };
export type SessionConfigOption = {
  id: string;
  name: string;
  category?: string | null;
  description?: string | null;
} & (
  | {
      type: 'select';
      currentValue: string;
      options: (ConfigChoice | { group: string; name: string; options: ConfigChoice[] })[];
    }
  | { type: 'boolean'; currentValue: boolean }
);

export type LoadedSession = {
  agent: string;
  sessionId: string;
  title?: string;
  updatedAt?: string;
  modes?: SessionModes | null;
  configOptions?: SessionConfigOption[] | null;
};

export type PermissionRequest = {
  agent: string;
  sessionId: string;
  toolCall?: { title?: string; kind?: string; rawInput?: unknown };
  options?: { optionId: string; name: string; kind?: string }[];
};

export type CreatedSession = {
  agent?: string;
  sessionId?: string;
  title?: string;
  updatedAt?: string;
  modes?: SessionModes | null;
  configOptions?: SessionConfigOption[] | null;
};

type ListResponse = { sessions?: RemoteSession[]; nextCursor?: string };

// Allow ACP startup/history work more time than the lightweight host handshake.
const sessionTimeoutSeconds = 60;

export class AgentApi {
  #peer: RpcPeer;

  constructor(send: (message: RpcMessage) => void | Promise<void>, onTimeout?: (id: RpcId) => void | Promise<void>) {
    this.#peer = new RpcPeer(send, onTimeout);
  }

  dispatch = (message: RpcMessage) => this.#peer.dispatch(message);

  rejectAll = (error: Error) => this.#peer.rejectAll(error);

  setPermissionHandler = (handler: (request: PermissionRequest) => Promise<string>) =>
    this.#peer.handle('agent_permission_request', (params) =>
      handler(params as PermissionRequest).then((optionId) => ({ optionId })),
    );

  setSessionEndedHandler = (handler: (params: { agent: string; sessionId: string }) => void) =>
    this.#peer.onNotify('agent_session_ended', (params) => handler(params as { agent: string; sessionId: string }));

  setHostReconnectedHandler = (handler: () => void) => this.#peer.onNotify('host_reconnected', () => handler());

  attachPeer = async (deviceId: string) => {
    return this.#peer.call<{ peerId: number }>('peer_attach', { deviceId }, undefined, {
      timeoutMs: 10_000,
      timeoutMessage: i18n.get('error.connectHostTimeout'),
    });
  };

  readFile = (path: string, cwd: string) =>
    this.#peer.call<RemoteFile>('file_read', { path, cwd }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.readFileTimeout'),
    });

  browseFiles = async (path = '', options?: FileBrowseOptions | string): Promise<FileBrowseResult> => {
    const opts: FileBrowseOptions = typeof options === 'string' ? { cwd: options } : options || {};
    const result = await this.#peer.call<{
      path?: string;
      home?: string;
      entries?: BrowseEntry[];
    }>(
      'file_browse',
      {
        path,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        limit: opts.limit ?? 200,
      },
      undefined,
      {
        timeoutMs: 15_000,
        timeoutMessage: i18n.get('error.readCwdTimeout'),
      },
    );
    return {
      path: typeof result.path === 'string' ? result.path : '',
      home: typeof result.home === 'string' ? result.home : undefined,
      entries: Array.isArray(result.entries)
        ? result.entries.filter(
            (entry): entry is BrowseEntry =>
              Boolean(entry) && typeof entry.name === 'string' && typeof entry.path === 'string',
          )
        : [],
    };
  };

  createSession = ({ agent, cwd }: { agent: string; cwd: string }) =>
    this.#peer.call<CreatedSession>(
      'agent_session_create',
      { agent, cwd, timeoutSeconds: sessionTimeoutSeconds },
      undefined,
      {
        timeoutMs: 65_000,
        timeoutMessage: i18n.get('error.createSessionTimeout'),
      },
    );

  listSessions = async (agent: string) => {
    const sessions: RemoteSession[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.#peer.call<ListResponse>(
        'agent_session_list',
        {
          agent,
          timeoutSeconds: sessionTimeoutSeconds,
          ...(cursor ? { cursor } : {}),
        },
        undefined,
        { timeoutMs: 65_000, timeoutMessage: i18n.get('error.readSessionListTimeout') },
      );
      if (Array.isArray(result.sessions)) sessions.push(...result.sessions);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error(i18n.get('error.duplicateSessionCursor'));
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return sessions;
  };

  loadSession = (session: RemoteSession, agent: string, onEvent: (event: SessionEvent) => void) =>
    this.#peer.call<LoadedSession>(
      'agent_session_load',
      { agent, sessionId: session.sessionId, cwd: session.cwd, stream: true, timeoutSeconds: sessionTimeoutSeconds },
      (event) => onEvent(event as SessionEvent),
      { timeoutMs: 65_000, timeoutMessage: i18n.get('error.loadSessionTimeout') },
    );

  setSessionMode = (agent: string, sessionId: string, modeId: string) =>
    this.#peer.call('agent_session_set_mode', { agent, sessionId, modeId }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.switchModeTimeout'),
    });

  setSessionModeOption = (agent: string, sessionId: string, configId: string, value: string) =>
    this.#peer.call<{ configOptions: SessionConfigOption[] }>(
      'agent_session_set_config_option',
      { agent, sessionId, configId, value },
      undefined,
      {
        timeoutMs: 15_000,
        timeoutMessage: i18n.get('error.switchModeTimeout'),
      },
    );

  prompt = (
    sessionId: string,
    agent: string,
    prompt: string,
    onEvent: (event: SessionEvent) => void,
    attachments: PromptAttachment[] = [],
  ) =>
    this.#peer.call<{ answer?: string }>(
      'agent_prompt',
      { agent, sessionId, prompt, attachments, stream: true },
      (event) => onEvent(event as SessionEvent),
    );

  cancelPrompt = (sessionId: string, agent: string) =>
    this.#peer.call<{ cancelled?: boolean }>('agent_prompt_cancel', { agent, sessionId }, undefined, {
      timeoutMs: 10_000,
      timeoutMessage: i18n.get('error.cancelTaskTimeout'),
    });

  closeSession = (agent: string, sessionId: string) =>
    this.#peer.call<{ closed?: boolean }>('agent_session_close', { agent, sessionId }, undefined, {
      timeoutMs: 10_000,
      timeoutMessage: i18n.get('error.closeSessionTimeout'),
    });

  deleteSession = (agent: string, sessionId: string) =>
    this.#peer.call<{ deleted: boolean }>(
      'agent_session_delete',
      { agent, sessionId, timeoutSeconds: sessionTimeoutSeconds },
      undefined,
      { timeoutMs: 65_000, timeoutMessage: i18n.get('error.deleteSessionTimeout') },
    );
}
