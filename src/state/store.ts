import type { PermissionRequest } from '../agent/api';
import type { ConnectionState } from '../agent/transport';
import { popularAgents, readSettings } from '../config';
import { getSortedSessionGroups, type SessionGroup } from '../session/groups';
import type { ChatMessage, DeckSession, SessionOptions } from '../session/types';

const initialSettings = readSettings();

export const agentdeckStore = createStore({
  settings: initialSettings,
  agents: popularAgents,
  connection: (initialSettings.relayId ? 'connecting' : 'disconnected') as ConnectionState,
  connectionError: '',
  draftSession: null as DeckSession | null,
  sessions: [] as DeckSession[],
  sessionGroups: [] as SessionGroup[],
  sessionsLoading: false,
  sessionsLoaded: false,
  sessionsError: '',
  messagesBySession: {} as Record<string, ChatMessage[]>,
  loadedSessionIds: [] as string[],
  loadingSessionIds: [] as string[],
  pendingSessionIds: [] as string[],
  unreadSessionIds: [] as string[],
  changingModeSessionIds: [] as string[],
  errorsBySession: {} as Record<string, string>,
  optionsBySession: {} as Record<string, SessionOptions>,
  permissionsBySession: {} as Record<string, PermissionRequest>,
});

export const clearSessionError = (sessionId: string) => {
  const next = { ...agentdeckStore.errorsBySession };
  delete next[sessionId];
  agentdeckStore({ errorsBySession: next });
};

export const setSessionFlag = (
  key: 'loadedSessionIds' | 'loadingSessionIds' | 'pendingSessionIds' | 'unreadSessionIds' | 'changingModeSessionIds',
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
    sessionGroups: getSortedSessionGroups(nextSessions),
  });
};

export const updateSessionOptions = (sessionId: string, patch: Partial<SessionOptions>) => {
  const current = agentdeckStore.optionsBySession[sessionId] ?? {};
  agentdeckStore({
    optionsBySession: { ...agentdeckStore.optionsBySession, [sessionId]: { ...current, ...patch } },
  });
};
