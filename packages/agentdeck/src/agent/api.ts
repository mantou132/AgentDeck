import { i18n } from '../i18n';
import type { RpcId, RpcMessage } from './rpc';
import { RpcPeer } from './rpc';

type CreateSessionOptions = {
  agent: string;
  cwd: string;
  panelContext?: PanelContext | unknown;
};

type LoadSessionOptions = {
  agent: string;
  sessionId: string;
  cwd?: string;
  onEvent?: (event: SessionEvent) => void;
  panelContext?: PanelContext | unknown;
};

type ResumePromptHandlers = {
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  resolve?: (value: { answer?: string }) => void;
  reject?: (error: Error) => void;
};

export type RemoteFile = { path: string } & (
  | { type: 'text'; text: string }
  | { type: 'image'; data: Uint8Array<ArrayBuffer>; mimeType: string }
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

export type GitFileStatus = {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'typechange' | 'conflicted' | string;
  insertions: number;
  deletions: number;
};

export type GitDiffStats = {
  insertions: number;
  deletions: number;
  filesChanged: number;
};

export type GitStatusResult = {
  repo: string;
  branch?: string;
  files: GitFileStatus[];
  stats?: GitDiffStats | null;
};

export type GitCommit = {
  id: string;
  shortId: string;
  summary: string;
  author: string;
  /** Millisecond timestamp */
  time: number;
};

export type GitLogResult = {
  repo: string;
  branch?: string;
  commits: GitCommit[];
};

export type GitShowResult = {
  repo: string;
  commit: GitCommit;
  files: GitFileStatus[];
  stats?: GitDiffStats | null;
};

export type GitDiffResult = {
  diff: string;
  path?: string;
  stats?: GitDiffStats | null;
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
  requestId: string;
  toolCall?: { title?: string; kind?: string; rawInput?: unknown };
  options?: { optionId: string; name: string; kind?: string }[];
};

export type ElicitationOption = { const: string; title?: string; description?: string };

/** A form field of an ACP form elicitation (a restricted JSON Schema). */
export type ElicitationProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: ElicitationOption[];
  items?: { enum?: string[]; anyOf?: ElicitationOption[] };
};

/** ACP form elicitation forwarded by the host; `requestId` identifies it when answering. */
export type ElicitationRequest = {
  agent: string;
  sessionId: string;
  requestId: string;
  toolCallId?: string;
  message: string;
  requestedSchema: { properties: Record<string, ElicitationProperty>; required?: string[] };
};

export type ElicitationValue = string | number | boolean | string[];

export type ElicitationResponse =
  | { action: 'accept'; content: Record<string, ElicitationValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

/** Without `optionId` the tool call is cancelled. */
export type PermissionResponse = { optionId?: string };

/** A request waiting for the user, as the host lists it after reconnecting. */
export type UserInput =
  | { method: 'agent_permission_request'; params: PermissionRequest }
  | { method: 'agent_elicitation_request'; params: ElicitationRequest };

export type CreatedSession = {
  agent?: string;
  sessionId?: string;
  title?: string;
  updatedAt?: string;
  modes?: SessionModes | null;
  configOptions?: SessionConfigOption[] | null;
};

export type PanelContext =
  | { surface: 'devtools' | 'side_panel'; tabId?: number; url?: string }
  | { surface: 'remote_app' };

export const REMOTE_APP_PANEL_CONTEXT: PanelContext = { surface: 'remote_app' };

/** Output the client can render; the host loads matching skills into agent sessions (e.g. `render: ['chart']`). */
export type ClientCapabilities = { render?: string[] };

/** Device shape drawn around a screen capture; geometry is in the capture's native pixels. */
export type ScreenFrame =
  | { kind: 'phone'; cornerRadius: number; cutouts?: { path: string; transform: string }[] }
  | { kind: 'browser'; title: string; url: string; mobile: boolean };

export type ScreenCapture = { width: number; height: number; frame: ScreenFrame };

export type PromptSuggestion = { agent: string; sessionId: string; suggestion: string };

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

  /** Requests waiting for the user arrive as notifications; answers go through `respondUserInput`. */
  setUserInputHandler = (handler?: ((input: UserInput) => void) | null) => {
    for (const method of ['agent_permission_request', 'agent_elicitation_request'] as const) {
      this.#peer.onNotify(method, (params) => handler?.({ method, params } as UserInput));
    }
  };

  setSessionEndedHandler = (handler?: ((params: { agent: string; sessionId: string }) => void) | null) =>
    this.#peer.onNotify('agent_session_ended', (params) => handler?.(params as { agent: string; sessionId: string }));

  /** Claude's predicted next prompt, sent after a turn to the device that started it. */
  setPromptSuggestionHandler = (handler?: ((params: PromptSuggestion) => void) | null) =>
    this.#peer.onNotify('agent_prompt_suggestion', (params) => handler?.(params as PromptSuggestion));

  setHostReconnectedHandler = (handler?: (() => void) | null) =>
    this.#peer.onNotify('host_reconnected', () => handler?.());

  attachPeer = async (deviceId: string, fcmToken?: string | null, capabilities?: ClientCapabilities) => {
    return this.#peer.call<{ peerId: number; version?: string }>(
      'peer_attach',
      { deviceId, fcmToken, capabilities },
      undefined,
      {
        timeoutMs: 10_000,
        timeoutMessage: i18n.get('error.connectHostTimeout'),
      },
    );
  };

  /** One JPEG frame of an app on the host (`ios:` / `android:` / `browser:` target), at most `maxWidth` wide. */
  captureScreen = (target: string, maxWidth: number) =>
    this.#peer.call<ScreenCapture & { data: Uint8Array<ArrayBuffer> }>(
      'screen_capture',
      { target, maxWidth },
      undefined,
      { timeoutMs: 10_000, timeoutMessage: i18n.get('screen.timeout'), ephemeral: true },
    );

  /** Any host file as raw bytes, for serving it verbatim; `range` is `[offset, length]` of one slice. */
  readRawFile = (path: string, range?: [number, number]) =>
    this.#peer.call<{ path: string; type: 'binary'; size: number; data: Uint8Array<ArrayBuffer> }>(
      'file_read',
      range ? { path, raw: true, offset: range[0], length: range[1] } : { path, raw: true },
      undefined,
      {
        timeoutMs: 30_000,
        timeoutMessage: i18n.get('error.readFileTimeout'),
        ephemeral: true,
      },
    );

  readFile = (path: string, cwd: string) =>
    this.#peer.call<RemoteFile>('file_read', { path, cwd }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.readFileTimeout'),
      ephemeral: true,
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

  /** Whether `path` can be listed as a directory; any failure counts as not a directory. */
  isDirectory = (path: string, cwd: string) =>
    this.browseFiles(path, { cwd, limit: 1 }).then(
      () => true,
      () => false,
    );

  gitStatus = (cwd: string) =>
    this.#peer.call<GitStatusResult>('git_status', { cwd }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.gitStatusTimeout'),
    });

  gitDiff = (cwd: string, path?: string, commit?: string) =>
    this.#peer.call<GitDiffResult>(
      'git_diff',
      { cwd, ...(path ? { path } : {}), ...(commit ? { commit } : {}) },
      undefined,
      {
        timeoutMs: 15_000,
        timeoutMessage: i18n.get('error.gitDiffTimeout'),
      },
    );

  gitLog = (cwd: string) =>
    this.#peer.call<GitLogResult>('git_log', { cwd }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.gitLogTimeout'),
    });

  gitShow = (cwd: string, commit: string) =>
    this.#peer.call<GitShowResult>('git_show', { cwd, commit }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.gitDiffTimeout'),
    });

  createSession = ({ agent, cwd, panelContext }: CreateSessionOptions) =>
    this.#peer.call<CreatedSession>(
      'agent_session_create',
      { agent, cwd, ...(panelContext ? { panelContext } : {}), timeoutSeconds: sessionTimeoutSeconds },
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

  loadSession = ({ agent, sessionId, cwd, onEvent, panelContext }: LoadSessionOptions) =>
    this.#peer.call<LoadedSession>(
      'agent_session_load',
      {
        agent,
        sessionId,
        ...(cwd ? { cwd } : {}),
        stream: true,
        timeoutSeconds: sessionTimeoutSeconds,
        ...(panelContext ? { panelContext } : {}),
      },
      onEvent ? (event) => onEvent(event as SessionEvent) : undefined,
      { timeoutMs: 65_000, timeoutMessage: i18n.get('error.loadSessionTimeout') },
    );

  setSessionMode = (agent: string, sessionId: string, modeId: string, timeoutMs = 15_000) =>
    this.#peer.call('agent_session_set_mode', { agent, sessionId, modeId }, undefined, {
      timeoutMs,
      timeoutMessage: i18n.get('error.switchModeTimeout'),
    });

  setSessionConfigOption = (agent: string, sessionId: string, configId: string, value: string, timeoutMs = 15_000) =>
    this.#peer.call<{ configOptions: SessionConfigOption[] }>(
      'agent_session_set_config_option',
      { agent, sessionId, configId, value },
      undefined,
      {
        timeoutMs,
        timeoutMessage: i18n.get('error.switchModeTimeout'),
      },
    );

  prompt = (
    sessionId: string,
    agent: string,
    prompt: string,
    onEvent: (event: SessionEvent) => void | Promise<void>,
    attachments: PromptAttachment[] = [],
    callId?: RpcId,
    voiceChat?: boolean,
  ) =>
    this.#peer.call<{ answer?: string }>(
      'agent_prompt',
      { agent, sessionId, prompt, attachments, voiceChat, stream: true },
      (event) => onEvent(event as SessionEvent),
      undefined,
      callId,
    );

  resumePrompt = (rpcId: RpcId, handlers: ResumePromptHandlers) =>
    this.#peer.resumeCall(rpcId, {
      onEvent: (event) => handlers.onEvent?.(event as SessionEvent),
      resolve: (value) => handlers.resolve?.(value as { answer?: string }),
      reject: handlers.reject,
    });

  forgetPrompt = (rpcId: RpcId) => this.#peer.forget(rpcId);

  listRunningPrompts = () =>
    this.#peer.call<{ sessions: { agent: string; sessionId: string }[]; userInputs?: UserInput[] }>(
      'agent_prompts_running',
      {},
      undefined,
      { timeoutMs: 10_000, timeoutMessage: 'List running prompts timeout' },
    );

  respondUserInput = (
    { agent, sessionId, requestId }: PermissionRequest | ElicitationRequest,
    response: PermissionResponse | ElicitationResponse,
  ) =>
    this.#peer.call('agent_user_input_respond', { agent, sessionId, requestId, response }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.userInputTimeout'),
    });

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

  completeCwd = (input = '', cwd?: string, limit?: number) =>
    this.#peer.call<{ directories: string[]; value?: string; isDirectory?: boolean }>(
      'agent_cwd_complete',
      { input, cwd, limit },
      undefined,
      {
        timeoutMs: 10_000,
        timeoutMessage: 'Complete cwd timeout',
      },
    );

  deleteSession = (agent: string, sessionId: string) =>
    this.#peer.call<{ deleted: boolean }>(
      'agent_session_delete',
      { agent, sessionId, timeoutSeconds: sessionTimeoutSeconds },
      undefined,
      { timeoutMs: 65_000, timeoutMessage: i18n.get('error.deleteSessionTimeout') },
    );
}
