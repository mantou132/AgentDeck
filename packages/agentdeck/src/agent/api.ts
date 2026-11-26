import type { CallOptions, RpcId, RpcMessage } from 'src/agent/rpc';
import { RpcPeer } from 'src/agent/rpc';
import type { AgentInfo } from 'src/config';
import { i18n } from 'src/i18n';

type CreateSessionOptions = {
  agent: string;
  cwd: string;
  panelContext?: PanelContext | unknown;
};

type OpenSessionOptions = {
  agent: string;
  sessionId: string;
  cwd?: string;
  sinceEpoch?: string;
  sinceSeq?: number;
  onEvent?: (event: SessionEvent) => void;
  panelContext?: PanelContext | unknown;
};

type ForkSessionOptions = {
  agent: string;
  sessionId: string;
  cwd: string;
  messageId: string;
};

export type PromptOptions = {
  agent: string;
  sessionId: string;
  prompt: string;
  attachments?: PromptAttachment[];
  voiceChat?: boolean;
  clientMessageId?: string;
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

export type PromptAttachment =
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'text'; text: string }
  | { type: 'file'; name: string; data: string; mimeType: string }
  | { type: 'resource'; uri: string; name: string };

export type RemoteSession = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  additionalDirectories?: string[];
  /** Set by the host when `cwd` lies in a linked git worktree; the session is listed with `mainCwd`. */
  worktree?: { mainCwd: string; name: string };
  /** Set by the host on sessions of scheduled task runs, which the list leaves out. */
  task?: { id: string; name: string };
};

/**
 * When a scheduled task runs; daily times are in `timeZone` (IANA name, the saving device's), weekdays are 1 (Monday)
 * to 7, empty means every day.
 */
export type TaskSchedule =
  | { type: 'daily'; times: string[]; weekdays?: number[]; timeZone: string }
  | { type: 'interval'; minutes: number };

/** A scheduled task as the daemon stores it (`crates/daemon/src/tasks.rs`). */
export type Task = {
  id: string;
  name: string;
  agent: string;
  cwd: string;
  prompt: string;
  schedule: TaskSchedule;
  configOptions: Record<string, string>;
  timeoutMinutes: number;
  retries: number;
  enabled: boolean;
  /** The session the task was made in; changes are asked for there. */
  originSessionId?: string;
  createdAt: string;
};

export type TaskRun = {
  sessionId?: string | null;
  /** Missing for "run now". */
  scheduledFor?: string | null;
  startedAt: string;
  endedAt: string;
  status: 'success' | 'failed' | 'timeout';
  summary: string;
  attempt: number;
};

export type TaskListItem = Task & {
  nextRunAt?: string | null;
  lastRun?: TaskRun | null;
  running: boolean;
  /** Session of the running attempt, once created; its permission requests are answered from the task. */
  runningSessionId?: string | null;
};

/** A task to create or replace; the host sets `createdAt`. */
export type TaskInput = Omit<Task, 'id' | 'createdAt'> & { id?: string };

/** ACP slash command; the prompt `/name args` runs it. */
export type AvailableCommand = { name: string; description: string; input?: { hint: string } | null };

/** `childSessionId` marks an update of a subagent session (ACP Subagent Sessions RFD) of the session. */
export type SessionEvent =
  | { seq: number; event: 'session_update'; update: Record<string, unknown>; childSessionId?: string }
  | { seq: number; event: 'turn_started' }
  | { seq: number; event: 'turn_ended'; stopReason?: string; error?: string; code?: string };

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

export type OpenedSession = {
  agent: string;
  sessionId: string;
  epoch: string;
  seq: number;
  title?: string;
  updatedAt?: string;
  modes?: SessionModes | null;
  configOptions?: SessionConfigOption[] | null;
  running: boolean;
  userInputs: UserInput[];
  suggestion?: string | null;
  fullReplay: boolean;
  freshLoad: boolean;
};

export type ActiveSessionInfo = {
  agent: string;
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
};

export type PermissionRequest = {
  agent: string;
  sessionId: string;
  /** The subagent session asking; `sessionId` is its root session. */
  childSessionId?: string;
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
  /** The subagent session asking; `sessionId` is its root session. */
  childSessionId?: string;
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
  epoch?: string;
  seq?: number;
  title?: string;
  updatedAt?: string;
  modes?: SessionModes | null;
  configOptions?: SessionConfigOption[] | null;
};

export type PanelContext =
  | { surface: 'devtools' | 'side_panel'; tabId?: number; url?: string }
  | { surface: 'remote_app' };

export const REMOTE_APP_PANEL_CONTEXT: PanelContext = { surface: 'remote_app' };

/** Skill files keyed by `<skill>/<path>`; the host stores each version under its content hash. */
export type SkillBundle = { hash: string; files: Record<string, string> };

/**
 * Skills the client ships and the ones enabled on it; the host mounts those into agent sessions (e.g. `chart`).
 * Only the hash and names go with `peer_attach`; `load` fetches the files when the host lacks this version.
 */
export type ClientSkills = {
  hash: string;
  enabled: string[];
  /** Group of each supported skill, which hosts offer by name or group. */
  groups: Record<string, string>;
  load: () => Promise<SkillBundle>;
};

/** Device shape drawn around a screen capture; geometry is in the capture's native pixels. */
export type ScreenFrame =
  | { kind: 'phone'; cornerRadius: number; cutouts?: { path: string; transform: string }[] }
  | { kind: 'browser'; title: string; url: string; mobile: boolean };

export type ScreenCapture = { width: number; height: number; frame: ScreenFrame };

export type SessionEventNotification = {
  agent: string;
  sessionId: string;
  epoch: string;
  event: SessionEvent;
};

export type SessionStateUpdate = {
  agent: string;
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  running: boolean;
  completed?: boolean;
  error?: string;
  code?: string;
};

export type UserInputResolvedNotification = {
  agent: string;
  sessionId: string;
  requestId: string;
};

export type PromptSuggestion = { agent: string; sessionId: string; suggestion: string };

/** What the host's agent does before a call can run: downloading it, or launching it (`npx` / `uvx` download then). */
export type AgentStatus = 'installing' | 'starting';

type ListResponse = { sessions?: RemoteSession[]; nextCursor?: string };

// Allow ACP startup/history work more time than the lightweight host handshake.
const sessionTimeoutSeconds = 60;
// Daemon's per-read limit for `file_read`.
const RAW_CHUNK_BYTES = 8 * 1024 * 1024;

type PeerAttachResult = {
  peerId: number;
  version?: string;
  hostname?: string;
  home?: string;
  customAgents: AgentInfo[];
  /** The host lacks the declared skills; the client sends them before using the host. */
  skillsMissing?: boolean;
  /** Declared skills the host doesn't offer; old hosts omit it. */
  restrictedFeatures?: string[];
};

export class AgentApi {
  #peer: RpcPeer;
  #onAgentStatus?: (agent: string, status?: AgentStatus) => void;

  constructor(send: (message: RpcMessage) => void | Promise<void>, onTimeout?: (id: RpcId) => void | Promise<void>) {
    this.#peer = new RpcPeer(send, onTimeout);
  }

  dispatch = (message: RpcMessage) => this.#peer.dispatch(message);

  rejectAll = (error: Error) => this.#peer.rejectAll(error);

  rejectEphemeral = (error: Error) => this.#peer.rejectEphemeral(error);

  rejectTimed = (error: Error) => this.#peer.rejectTimed(error);

  touch = (id: RpcId) => this.#peer.touch(id);

  /** Requests waiting for the user arrive as notifications; answers go through `respondUserInput`. */
  setUserInputHandler = (handler?: ((input: UserInput) => void) | null) => {
    for (const method of ['agent_permission_request', 'agent_elicitation_request'] as const) {
      this.#peer.onNotify(method, (params) => handler?.({ method, params } as UserInput));
    }
  };

  setUserInputResolvedHandler = (handler?: ((params: UserInputResolvedNotification) => void) | null) =>
    this.#peer.onNotify('agent_user_input_resolved', (params) => handler?.(params as UserInputResolvedNotification));

  setSessionEndedHandler = (handler?: ((params: { agent: string; sessionId: string }) => void) | null) =>
    this.#peer.onNotify('agent_session_ended', (params) => handler?.(params as { agent: string; sessionId: string }));

  /** Claude's predicted next prompt, sent after a turn to subscribed peers. */
  setPromptSuggestionHandler = (handler?: ((params: PromptSuggestion) => void) | null) =>
    this.#peer.onNotify('agent_prompt_suggestion', (params) => handler?.(params as PromptSuggestion));

  /** Sequenced session events sent to subscribed peers. */
  setSessionEventHandler = (handler?: ((params: SessionEventNotification) => void) | null) =>
    this.#peer.onNotify('agent_session_event', (params) => handler?.(params as SessionEventNotification));

  /** Broadcast session lifecycle updates (turn started/ended, metadata changes). */
  setSessionStateHandler = (handler?: ((params: SessionStateUpdate) => void) | null) =>
    this.#peer.onNotify('agent_session_state', (params) => handler?.(params as SessionStateUpdate));

  /** The host reports `status` while starting `agent` for a session call; `undefined` once that call settles. */
  setAgentStatusHandler = (handler?: ((agent: string, status?: AgentStatus) => void) | null) => {
    this.#onAgentStatus = handler ?? undefined;
  };

  /** A session call that starts `agent` first; its `agent_status` frames go to the status handler. */
  #agentCall = async <T>(
    agent: string,
    method: string,
    params: Record<string, unknown>,
    options: CallOptions,
    onEvent?: (event: unknown) => void | Promise<void>,
  ) => {
    let reported = false;
    try {
      return await this.#peer.call<T>(
        method,
        { agent, ...params },
        (event) => {
          if ((event as { event?: string }).event !== 'agent_status') return onEvent?.(event);
          reported = true;
          this.#onAgentStatus?.(agent, (event as { status: AgentStatus }).status);
        },
        options,
      );
    } finally {
      if (reported) this.#onAgentStatus?.(agent);
    }
  };

  setHostReconnectedHandler = (handler?: (() => void) | null) =>
    this.#peer.onNotify('host_reconnected', () => handler?.());

  /** A scheduled task changed, or one of its runs started or ended. */
  setTaskUpdatedHandler = (handler?: ((params: { id: string }) => void) | null) =>
    this.#peer.onNotify('task_updated', (params) => handler?.(params as { id: string }));

  attachPeer = async (deviceId: string, fcmToken?: string | null, skills?: ClientSkills) => {
    const declared = skills && { hash: skills.hash, enabled: skills.enabled, groups: skills.groups };
    return this.#peer.call<PeerAttachResult>('peer_attach', { deviceId, fcmToken, skills: declared }, undefined, {
      timeoutMs: 10_000,
      timeoutMessage: i18n.get('error.connectHostTimeout'),
    });
  };

  installSkills = (skills: SkillBundle) =>
    this.#peer.call('skills_install', skills, undefined, {
      timeoutMs: 30_000,
      timeoutMessage: i18n.get('error.connectHostTimeout'),
    });

  /** One JPEG frame of an app on the host (`ios:` / `android:` / `browser:` target), at most `maxWidth` wide. */
  captureScreen = (target: string, maxWidth: number) =>
    this.#peer.call<ScreenCapture & { data: Uint8Array<ArrayBuffer> }>(
      'screen_capture',
      { target, maxWidth },
      undefined,
      { timeoutMs: 10_000, timeoutMessage: i18n.get('screen.timeout'), ephemeral: true },
    );

  /** Continuous live stream of frames for an app on the host (`ios:` / `android:` / `browser:` target). */
  streamScreen = (
    target: string,
    maxWidth: number,
    onFrame: (frame: ScreenCapture & { data: Uint8Array<ArrayBuffer> }) => void,
    callId?: string,
  ) =>
    this.#peer.call<void>(
      'screen_stream',
      { target, maxWidth },
      (event) => {
        if ((event as { keepalive?: boolean } | null)?.keepalive) return;
        onFrame(event as ScreenCapture & { data: Uint8Array<ArrayBuffer> });
      },
      { timeoutMs: 30_000, timeoutMessage: i18n.get('screen.timeout'), ephemeral: true },
      callId,
    );

  /** Stop an active live screen stream on the host. */
  stopStreamScreen = (target: string) =>
    this.#peer.call<void>('screen_stream_stop', { target }, undefined, {
      timeoutMs: 5000,
      timeoutMessage: i18n.get('screen.timeout'),
      ephemeral: true,
    });

  /** Send a normalized tap (`x`, `y` in `[0, 1]`) to a screen target (`android:` / `browser:`). */
  tapScreen = (target: string, x: number, y: number) =>
    this.#peer.call<void>('screen_input', { target, action: 'tap', x, y }, undefined, {
      timeoutMs: 5000,
      timeoutMessage: i18n.get('screen.timeout'),
      ephemeral: true,
    });

  /** Any host file as raw bytes, for serving it verbatim; `range` is `[offset, length]` of one slice. */
  readRawFile = (path: string, range?: [number, number], cwd?: string) =>
    this.#peer.call<{ path: string; type: 'binary'; size: number; data: Uint8Array<ArrayBuffer> }>(
      'file_read',
      range ? { path, cwd, raw: true, offset: range[0], length: range[1] } : { path, cwd, raw: true },
      undefined,
      {
        timeoutMs: 30_000,
        timeoutMessage: i18n.get('error.readFileTimeout'),
        ephemeral: true,
      },
    );

  /** A whole host file as raw bytes, read in slices within the daemon's per-read limit. */
  readWholeRawFile = async (path: string, cwd?: string) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0, size = 1; offset < size; ) {
      const result = await this.readRawFile(path, [offset, RAW_CHUNK_BYTES], cwd);
      // The file shrank while reading
      if (!result.data.length) break;
      chunks.push(result.data);
      offset += result.data.length;
      size = result.size;
    }
    return chunks;
  };

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
    this.#agentCall<CreatedSession>(
      agent,
      'agent_session_create',
      { cwd, ...(panelContext ? { panelContext } : {}), timeoutSeconds: sessionTimeoutSeconds },
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
      const result = await this.#agentCall<ListResponse>(
        agent,
        'agent_session_list',
        {
          timeoutSeconds: sessionTimeoutSeconds,
          ...(cursor ? { cursor } : {}),
        },
        { timeoutMs: 65_000, timeoutMessage: i18n.get('error.readSessionListTimeout') },
      );
      if (Array.isArray(result.sessions)) sessions.push(...result.sessions);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error(i18n.get('error.duplicateSessionCursor'));
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return sessions;
  };

  openSession = ({ agent, sessionId, cwd, sinceEpoch, sinceSeq, onEvent, panelContext }: OpenSessionOptions) =>
    this.#agentCall<OpenedSession>(
      agent,
      'agent_session_open',
      {
        sessionId,
        ...(cwd ? { cwd } : {}),
        ...(sinceEpoch ? { sinceEpoch, sinceSeq: sinceSeq ?? 0 } : {}),
        timeoutSeconds: sessionTimeoutSeconds,
        ...(panelContext ? { panelContext } : {}),
      },
      { timeoutMs: 65_000, timeoutMessage: i18n.get('error.loadSessionTimeout') },
      onEvent
        ? (frame) => {
            if (frame && typeof frame === 'object' && Array.isArray((frame as { events?: unknown }).events)) {
              for (const event of (frame as { events: SessionEvent[] }).events) onEvent(event);
            } else {
              onEvent(frame as SessionEvent);
            }
          }
        : undefined,
    );

  unsubscribeSession = (agent: string, sessionId: string) =>
    this.#peer.call<{ ok: boolean }>('agent_session_unsubscribe', { agent, sessionId }, undefined, {
      timeoutMs: 10_000,
      timeoutMessage: 'Unsubscribe session timeout',
    });

  /** Fork up to and including the agent message `messageId`; the new session is loaded like any other. */
  forkSession = ({ agent, sessionId, cwd, messageId }: ForkSessionOptions) =>
    this.#peer.call<{ sessionId: string }>(
      'agent_session_fork',
      { agent, sessionId, cwd, messageId, timeoutSeconds: sessionTimeoutSeconds },
      undefined,
      { timeoutMs: 65_000, timeoutMessage: i18n.get('error.forkSessionTimeout') },
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

  prompt = ({ agent, sessionId, prompt, attachments = [], voiceChat, clientMessageId }: PromptOptions) =>
    this.#peer.call<{ ok: boolean; agent: string; sessionId: string }>(
      'agent_prompt',
      {
        agent,
        sessionId,
        prompt,
        attachments,
        ...(voiceChat ? { voiceChat: true } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      },
      undefined,
      {
        timeoutMs: 30_000,
        timeoutMessage: i18n.get('error.sendMessageFailed'),
      },
    );

  listActiveSessions = () =>
    this.#peer.call<{ sessions: ActiveSessionInfo[]; userInputs?: UserInput[] }>(
      'agent_active_sessions',
      {},
      undefined,
      { timeoutMs: 10_000, timeoutMessage: 'List active sessions timeout' },
    );

  respondUserInput = (
    { agent, sessionId, requestId }: PermissionRequest | ElicitationRequest,
    response: PermissionResponse | ElicitationResponse,
  ) =>
    this.#peer.call('agent_user_input_respond', { agent, sessionId, requestId, response }, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.userInputTimeout'),
    });

  /** With `childSessionId`, cancels only that subagent's current work. */
  cancelPrompt = (sessionId: string, agent: string, childSessionId?: string) =>
    this.#peer.call<{ cancelled?: boolean }>('agent_prompt_cancel', { agent, sessionId, childSessionId }, undefined, {
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
        timeoutMessage: i18n.get('error.readCwdTimeout'),
      },
    );

  deleteSession = (agent: string, sessionId: string) =>
    this.#peer.call<{ deleted: boolean }>(
      'agent_session_delete',
      { agent, sessionId, timeoutSeconds: sessionTimeoutSeconds },
      undefined,
      { timeoutMs: 65_000, timeoutMessage: i18n.get('error.deleteSessionTimeout') },
    );

  #taskCall = <T>(method: string, params: Record<string, unknown>) =>
    this.#peer.call<T>(method, params, undefined, {
      timeoutMs: 15_000,
      timeoutMessage: i18n.get('error.taskTimeout'),
    });

  listTasks = () => this.#taskCall<{ tasks: TaskListItem[] }>('task_list', {}).then(({ tasks }) => tasks);

  /** Oldest first. */
  taskRuns = (id: string) => this.#taskCall<{ runs: TaskRun[] }>('task_runs', { id }).then(({ runs }) => runs);

  upsertTask = (task: TaskInput) => this.#taskCall<{ task: Task }>('task_upsert', { task }).then((r) => r.task);

  setTaskEnabled = (id: string, enabled: boolean) => this.#taskCall('task_set_enabled', { id, enabled });

  /** `started` is false while a run of the task is still going. */
  runTaskNow = (id: string) => this.#taskCall<{ started: boolean }>('task_run_now', { id });

  deleteTask = (id: string) => this.#taskCall('task_delete', { id });
}
