import type { PermissionRequest } from '../agent/api';
import type { ConnectionState } from '../agent/transport';
import { defaultAgents, readPairingHistory, readSavedCommands, readSettings } from '../config';
import type { Elicitation } from '../session/elicitation';
import { getSortedSessionGroups, type SessionGroup } from '../session/groups';
import type { ChatMessage, DeckSession, SessionOptions } from '../session/types';

const initialSettings = readSettings();

/** Settings and connection; changes rarely. */
export const agentdeckStore = createStore({
  settings: initialSettings,
  pairingHistory: readPairingHistory(),
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
  /** Session held locally: pending creation, created or running here, so it is known before the remote list has it. */
  session?: DeckSession;
  /** `loaded` means opened in this App lifecycle: it is never closed and loaded again. */
  load: LoadStatus;
  loadToken?: number;
  /** Running turn of this device; `rpcId` is missing while a pending session is being created. */
  turn?: { rpcId?: string };
  unread?: boolean;
  deleting?: boolean;
  error?: string;
  options?: SessionOptions;
  permission?: PermissionRequest;
  /** Form elicitations of this device's turns, kept read-only once answered; memory only. */
  elicitations?: Elicitation[];
  /** Agent-predicted next prompt, shown as the composer placeholder until the next turn. */
  suggestion?: string;
};

/** Session list and per-session runtime state; changes at turn and load boundaries, not with streamed content. */
export const sessionsStore = createStore({
  sessions: [] as DeckSession[],
  sessionGroups: [] as SessionGroup[],
  sessionsLoading: false,
  sessionsLoaded: false,
  sessionsError: '',
  runtimes: {} as Record<string, SessionRuntime>,
});

/** Messages change with every streamed chunk, so only elements that show them connect to this store. */
export const messagesStore = createStore({
  bySession: {} as Record<string, ChatMessage[]>,
});

const getPairing = (relayId: string) => agentdeckStore.pairingHistory.find((item) => item.relayId === relayId);

/** Home directory of the current host, remembered from its last handshake. */
/** Automatic reconnection in progress; errors raised meanwhile are cleared once connected. */
export const isConnecting = () => ['connecting', 'reconnecting', 'attaching'].includes(agentdeckStore.connection);

export const hostHome = () => getPairing(agentdeckStore.settings.relayId)?.home;

/** `free`, the host's custom agents remembered from its last handshake, then the other built-in agents. */
export const hostAgents = (relayId = agentdeckStore.settings.relayId) => {
  const custom = getPairing(relayId)?.customAgents ?? [];
  const [free, ...popular] = defaultAgents;
  return [free, ...custom, ...popular.filter((agent) => !custom.some(({ id }) => id === agent.id))];
};

const idleRuntime: SessionRuntime = { load: 'idle' };

export const getRuntime = (sessionId: string): SessionRuntime => sessionsStore.runtimes[sessionId] ?? idleRuntime;

export const updateRuntime = (sessionId: string, patch: Partial<SessionRuntime>) =>
  sessionsStore({ runtimes: { ...sessionsStore.runtimes, [sessionId]: { ...getRuntime(sessionId), ...patch } } });

export const isTurnRunning = (sessionId: string) => Boolean(getRuntime(sessionId).turn);

export const runningSessionIds = () =>
  Object.entries(sessionsStore.runtimes)
    .filter(([, runtime]) => runtime.turn)
    .map(([sessionId]) => sessionId);

export const getMessages = (sessionId: string): ChatMessage[] => messagesStore.bySession[sessionId] ?? [];

export const setMessages = (sessionId: string, messages: ChatMessage[]) =>
  messagesStore({ bySession: { ...messagesStore.bySession, [sessionId]: messages } });

/** Drops everything the App holds about the session. */
export const removeRuntime = (sessionId: string) => {
  const { [sessionId]: _runtime, ...runtimes } = sessionsStore.runtimes;
  const { [sessionId]: _messages, ...bySession } = messagesStore.bySession;
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
