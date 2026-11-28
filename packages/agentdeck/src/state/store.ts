import type { AgentStatus, PermissionRequest } from 'src/agent/api';
import type { ConnectionState } from 'src/agent/transport';
import {
  defaultAgents,
  readLanguage,
  readPairingHistory,
  readSavedCommands,
  readSettings,
  readSkillToggles,
  SKILL_REQUIRES,
  WORKFLOW_SKILLS,
} from 'src/config';
import type { Elicitation } from 'src/session/elicitation';
import { getSortedSessionGroups, type SessionGroup } from 'src/session/groups';
import type { ChatMessage, DeckSession, SessionOptions, Subagent } from 'src/session/types';

const initialSettings = readSettings();

/** Settings and connection; changes rarely. */
export const agentdeckStore = createStore({
  settings: initialSettings,
  pairingHistory: readPairingHistory(),
  /** Skills switched in settings; enabled ones (`isSkillEnabled`) are declared to the host. */
  skillToggles: readSkillToggles(),
  language: readLanguage(),
  connection: (initialSettings.relayId ? 'connecting' : 'disconnected') as ConnectionState,
  connectionError: '',
  /** Daemon version of the connected host; old hosts omit it. */
  hostVersion: '',
  /** Latest slash commands of each agent, also saved with its config defaults. */
  commandsByAgent: readSavedCommands(),
});

export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

/** Everything the App holds about one session besides its messages; removing a session drops the whole entry. */
export type SessionRuntime = {
  /** Session held locally: pending creation, created or running on the host, so it is known before the remote list has it. */
  session?: DeckSession;
  load: LoadStatus;
  loadToken?: number;
  /** Daemon reports a turn is currently running in this session. */
  running?: boolean;
  /** Pending session creation is in flight (before a remote session id exists). */
  creating?: boolean;
  /** Whether this client is currently subscribed to live `agent_session_event` frames for this session. */
  subscribed?: boolean;
  /** Actor epoch reported by the daemon, used for incremental `openSession` sync. */
  epoch?: string;
  /** Highest `seq` applied within `epoch`. */
  lastSeq?: number;
  unread?: boolean;
  deleting?: boolean;
  error?: string;
  options?: SessionOptions;
  permission?: PermissionRequest;
  /** Form elicitations of this session's turns, kept read-only once answered; memory only. */
  elicitations?: Elicitation[];
  /** Agent-predicted next prompt, shown as the composer placeholder until the next turn. */
  suggestion?: string;
  /** Subagent sessions (nested ones too) by session id; their messages are kept under those ids. */
  subagents?: Record<string, Subagent>;
};

/** Session list and per-session runtime state; changes at turn and load boundaries, not with streamed content. */
export const sessionsStore = createStore({
  sessions: [] as DeckSession[],
  sessionGroups: [] as SessionGroup[],
  sessionsLoading: false,
  sessionsLoaded: false,
  sessionsError: '',
  /** Agents the host is installing or starting for a session call. */
  agentStatus: {} as Record<string, AgentStatus>,
  runtimes: {} as Record<string, SessionRuntime>,
});

/** Messages change with every streamed chunk, so only elements that show them connect to this store. */
export const messagesStore = createStore({
  bySession: {} as Record<string, ChatMessage[]>,
});

const getPairing = (relayId: string) => agentdeckStore.pairingHistory.find((item) => item.relayId === relayId);

/** Automatic reconnection in progress; errors raised meanwhile are cleared once connected. */
export const isConnecting = () => ['connecting', 'reconnecting', 'attaching'].includes(agentdeckStore.connection);

/** Home directory of the current host, remembered from its last handshake. */
export const hostHome = () => getPairing(agentdeckStore.settings.relayId)?.home;

/** `free`, the host's custom agents remembered from its last handshake, then the other built-in agents. */
export const hostAgents = (relayId = agentdeckStore.settings.relayId) => {
  const custom = getPairing(relayId)?.customAgents ?? [];
  const [free, ...popular] = defaultAgents;
  return [free, ...custom, ...popular.filter((agent) => !custom.some(({ id }) => id === agent.id))];
};

/** The current host doesn't offer it (`agentdeckd --features`), as remembered from its last handshake. */
export const isSkillRestricted = (skill: string): boolean =>
  !!getPairing(agentdeckStore.settings.relayId)?.restrictedFeatures?.includes(skill);

/** Turned on (in settings, else by default), and so is the skill it requires. */
export const isSkillEnabled = (skill: string): boolean => {
  const required = SKILL_REQUIRES[skill];
  const enabled = agentdeckStore.skillToggles[skill] ?? !WORKFLOW_SKILLS.includes(skill);
  return enabled && (!required || isSkillEnabled(required));
};

const idleRuntime: SessionRuntime = { load: 'idle' };

export const getRuntime = (sessionId: string): SessionRuntime => sessionsStore.runtimes[sessionId] ?? idleRuntime;

export const updateRuntime = (sessionId: string, patch: Partial<SessionRuntime>) => {
  const nextPatch = patch.running ? { ...patch, unread: false } : patch;
  sessionsStore({ runtimes: { ...sessionsStore.runtimes, [sessionId]: { ...getRuntime(sessionId), ...nextPatch } } });
};

export const isTurnRunning = (sessionId: string) => {
  const runtime = getRuntime(sessionId);
  return Boolean(runtime.running || runtime.creating);
};

export const runningSessionIds = () =>
  Object.entries(sessionsStore.runtimes)
    .filter(([, runtime]) => runtime.running || runtime.creating)
    .map(([sessionId]) => sessionId);

export const getMessages = (sessionId: string): ChatMessage[] => messagesStore.bySession[sessionId] ?? [];

export const setMessages = (sessionId: string, messages: ChatMessage[]) =>
  messagesStore({ bySession: { ...messagesStore.bySession, [sessionId]: messages } });

/** The session id followed by its known subagent session ids. */
export const sessionTreeIds = (sessionId: string) => [sessionId, ...Object.keys(getRuntime(sessionId).subagents ?? {})];

/** Drops everything the App holds about the session, its subagents' messages included. */
export const removeRuntime = (sessionId: string) => {
  const ids = sessionTreeIds(sessionId);
  const { [sessionId]: _, ...runtimes } = sessionsStore.runtimes;
  const bySession = { ...messagesStore.bySession };
  for (const id of ids) delete bySession[id];
  sessionsStore({ runtimes });
  messagesStore({ bySession });
};

export const patchSession = (sessionId: string, patch: Partial<DeckSession>) => {
  const sessions = sessionsStore.sessions.map((session) =>
    session.sessionId === sessionId ? { ...session, ...patch } : session,
  );
  sessionsStore({ sessions, sessionGroups: getSortedSessionGroups(sessions, sessionsStore.sessionGroups) });
  const local = getRuntime(sessionId).session;
  if (local) updateRuntime(sessionId, { session: { ...local, ...patch } });
};

export const updateSessionOptions = (sessionId: string, patch: Partial<SessionOptions>) =>
  updateRuntime(sessionId, { options: { ...getRuntime(sessionId).options, ...patch } });
