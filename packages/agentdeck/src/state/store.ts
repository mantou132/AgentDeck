import type { PermissionRequest } from '../agent/api';
import type { ConnectionState } from '../agent/transport';
import { popularAgents, readPairingHistory, readSavedCommands, readSettings } from '../config';
import type { Elicitation } from '../session/elicitation';
import { getSortedSessionGroups, type SessionGroup } from '../session/groups';
import type { ChatMessage, DeckSession, SessionOptions } from '../session/types';

const initialSettings = readSettings();

export const agentdeckStore = createStore({
  settings: initialSettings,
  pairingHistory: readPairingHistory(),
  agents: popularAgents,
  connection: (initialSettings.relayId ? 'connecting' : 'disconnected') as ConnectionState,
  connectionError: '',
  /** Daemon version of the connected host; old hosts omit it. */
  hostVersion: '',
  pendingSession: null as DeckSession | null,
  sessions: [] as DeckSession[],
  sessionGroups: [] as SessionGroup[],
  sessionsLoading: false,
  sessionsLoaded: false,
  sessionsError: '',
  deletingSessionIds: [] as string[],
  messagesBySession: {} as Record<string, ChatMessage[]>,
  loadedSessionIds: [] as string[],
  loadingSessionIds: [] as string[],
  pendingSessionIds: [] as string[],
  unreadSessionIds: [] as string[],
  errorsBySession: {} as Record<string, string>,
  optionsBySession: {} as Record<string, SessionOptions>,
  permissionsBySession: {} as Record<string, PermissionRequest>,
  /** Form elicitations of this device's turns, kept read-only once answered; memory only. */
  elicitationsBySession: {} as Record<string, Elicitation[]>,
  /** Agent-predicted next prompt, shown as the composer placeholder until the next turn. */
  suggestionsBySession: {} as Record<string, string>,
  /** Latest slash commands of each agent, also saved with its config defaults. */
  commandsByAgent: readSavedCommands(),
});

/** Home directory of the current host, remembered from its last handshake. */
export const hostHome = () =>
  agentdeckStore.pairingHistory.find((item) => item.relayId === agentdeckStore.settings.relayId)?.home;

export const setPromptSuggestion = (sessionId: string, suggestion: string) => {
  const next = { ...agentdeckStore.suggestionsBySession };
  if (suggestion) next[sessionId] = suggestion;
  else delete next[sessionId];
  agentdeckStore({ suggestionsBySession: next });
};

export const clearSessionError = (sessionId: string) => {
  const next = { ...agentdeckStore.errorsBySession };
  delete next[sessionId];
  agentdeckStore({ errorsBySession: next });
};

export const setSessionFlag = (
  key: 'loadedSessionIds' | 'loadingSessionIds' | 'pendingSessionIds' | 'unreadSessionIds' | 'deletingSessionIds',
  sessionId: string,
  enabled: boolean,
) => {
  const next = agentdeckStore[key].filter((id) => id !== sessionId);
  if (enabled) next.push(sessionId);
  agentdeckStore({ [key]: next });
};

export const setMessages = (sessionId: string, messages: ChatMessage[]) =>
  agentdeckStore({ messagesBySession: { ...agentdeckStore.messagesBySession, [sessionId]: messages } });

export const setSessionError = (sessionId: string, error: string) =>
  agentdeckStore({ errorsBySession: { ...agentdeckStore.errorsBySession, [sessionId]: error } });

export const patchSession = (sessionId: string, patch: Partial<DeckSession>) => {
  const nextSessions = agentdeckStore.sessions.map((session) =>
    session.sessionId === sessionId ? { ...session, ...patch } : session,
  );
  agentdeckStore({
    sessions: nextSessions,
    sessionGroups: getSortedSessionGroups(nextSessions, agentdeckStore.sessionGroups),
  });
};

export const updateSessionOptions = (sessionId: string, patch: Partial<SessionOptions>) => {
  const current = agentdeckStore.optionsBySession[sessionId] ?? {};
  agentdeckStore({
    optionsBySession: { ...agentdeckStore.optionsBySession, [sessionId]: { ...current, ...patch } },
  });
};
