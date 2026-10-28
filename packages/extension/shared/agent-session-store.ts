import type { SessionConfigOption } from 'agentdeck/agent/api';

export const AGENT_PANEL_STATE_KEY = 'agentdeck.agent_panel_state.v1';

/** A local session record; `draft` marks the single in-memory session without an ACP session id. */
export type SessionRecord = {
  key: string;
  agent: string;
  sessionId?: string;
  title?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  draft?: boolean;
};

export type AgentDefaults = {
  agent: string;
  configOptionsByAgent: Record<string, SessionConfigOption[]>;
};

export type AgentPanelState = {
  relayId: string;
  sessions: SessionRecord[];
  defaults: AgentDefaults;
};

type StoredValue = Partial<Omit<AgentPanelState, 'defaults'>> & { defaults?: Partial<AgentDefaults> };

const emptyAgentPanelState = (): AgentPanelState => ({
  relayId: '',
  sessions: [],
  defaults: {
    agent: '',
    configOptionsByAgent: {},
  },
});

/** JSON tuple encoding is unambiguous even when an ACP session id contains
 * punctuation used by either agent. */
export function agentSessionKey(agent: string, sessionId?: string) {
  return JSON.stringify([agent, sessionId]);
}

export function sessionTitleFromPrompt(prompt: string, maxLength = 60) {
  const characters = Array.from(prompt.trim().replace(/\s+/g, ' '));
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join('')}…` : characters.join('');
}

function normalizeState(value?: StoredValue): AgentPanelState {
  if (!value || typeof value !== 'object') return emptyAgentPanelState();
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.filter(
        (session) =>
          session &&
          session.draft !== true &&
          typeof session.agent === 'string' &&
          session.agent &&
          typeof session.sessionId === 'string' &&
          session.sessionId,
      )
    : [];
  const defaults = value.defaults && typeof value.defaults === 'object' ? value.defaults : {};
  const configOptionsByAgent =
    defaults.configOptionsByAgent && typeof defaults.configOptionsByAgent === 'object'
      ? Object.fromEntries(
          Object.entries(defaults.configOptionsByAgent).filter(
            ([agent, configOptions]) => agent && Array.isArray(configOptions),
          ),
        )
      : {};
  return {
    relayId: typeof value.relayId === 'string' ? value.relayId : '',
    sessions: sortSessions(
      sessions.map((session) => ({
        ...session,
        key: agentSessionKey(session.agent, session.sessionId),
      })),
    ),
    defaults: {
      agent: typeof defaults.agent === 'string' ? defaults.agent : '',
      configOptionsByAgent,
    },
  };
}

function sortSessions(sessions: SessionRecord[]) {
  const timestamp = (session: SessionRecord) => Date.parse(session.updatedAt || session.createdAt || '') || 0;
  return sessions.toSorted((a, b) => timestamp(b) - timestamp(a));
}

export function upsertStoredSession(state: AgentPanelState, session: Omit<SessionRecord, 'key'>): AgentPanelState {
  const key = agentSessionKey(session.agent, session.sessionId);
  const nextSession = { ...session, key };
  const sessions = state.sessions.some((item) => item.key === key)
    ? state.sessions.map((item) => (item.key === key ? { ...item, ...nextSession } : item))
    : [nextSession, ...state.sessions];
  return { ...state, sessions: sortSessions(sessions) };
}

export function removeStoredSession(state: AgentPanelState, key: string): AgentPanelState {
  return { ...state, sessions: state.sessions.filter((session) => session.key !== key) };
}

export async function readAgentPanelState() {
  const stored = await chrome.storage.local.get(AGENT_PANEL_STATE_KEY);
  return normalizeState(stored[AGENT_PANEL_STATE_KEY] as StoredValue | undefined);
}

let writeQueue: Promise<unknown> = Promise.resolve();

/** Serialize writes originating in one extension page and always mutate the
 * freshest stored value, so session and default updates cannot overwrite one
 * another within that page. */
export function updateAgentPanelState(update: (state: AgentPanelState) => AgentPanelState) {
  const task = writeQueue.then(async () => {
    const current = await readAgentPanelState();
    const next = normalizeState(update(current));
    await chrome.storage.local.set({ [AGENT_PANEL_STATE_KEY]: next });
    return next;
  });
  writeQueue = task.catch(() => {});
  return task;
}

export function observeAgentPanelState(callback: (state: AgentPanelState) => void) {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    const change = changes[AGENT_PANEL_STATE_KEY];
    if (!change) return;
    callback(normalizeState(change.newValue as StoredValue | undefined));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
