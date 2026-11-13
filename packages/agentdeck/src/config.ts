import type { AvailableCommand } from './agent/api';
import { isPairingId } from './agent/encryption';
import { calendarSupported } from './lib/calendar';
import { previewSupported } from './lib/preview';
import type { SessionOptions } from './session/types';

export type AppSettings = {
  relayId: string;
  agent: string;
  /** Custom relay from a scanned pairing QR code; empty means `RELAY_URL`. */
  relayUrl?: string;
};

// Storage Keys (localStorage / sessionStorage)
export const SETTINGS_KEY = 'agentdeck.settings.v1';
export const DEVICE_ID_KEY = 'agentdeck.device_id.v1';
export const RESET_PENDING_KEY = 'agentdeck.reset_pending.v1';
export const RELAY_GUIDE_SEEN_KEY = 'agentdeck.relay_guide_seen.v1';
export const ACTIVE_MARKER_KEY = 'agentdeck.active_in_flight.v1';
export const FALLBACK_KEY = 'agentdeck.in_flight_fallback.v1';
export const SESSION_META_KEY = 'agentdeck.meta.v1';
export const CONFIG_DEFAULTS_KEY = 'agentdeck.config_defaults.v1';
export const PAIRING_HISTORY_KEY = 'agentdeck.pairing_history.v1';
export const EVENTS_ADDED_KEY = 'agentdeck.events_added.v1';
/** sessionStorage: the link that started the App was handled; AgentDeck reloads each time a saved app exits. */
export const LAUNCH_LINK_TAKEN_KEY = 'agentdeck.launch_link_taken.v1';
export const DISABLED_SKILLS_KEY = 'agentdeck.disabled_skills.v1';

// IndexedDB database names are unique within this app's origin.
// Keep all database/store identities here; retain existing names for persisted data.
export const DATABASES = {
  inFlight: { name: 'agentdeck-db', version: 1, storeName: 'in_flight_sessions', keyPath: 'sessionId' },
  drafts: { name: 'agentdeck-drafts', version: 1, storeName: 'drafts' },
  relay: { name: 'agentdeck-relay', version: 1, storeName: 'relay' },
} as const;

export const RELAY_URL = 'wss://agentdeck.xianqiao.wang/ws';
export const FEEDBACK_URL = 'https://github.com/mantou132/AgentDeck/issues/new';

/** Raise when the app needs a newer agentdeckd; older hosts get an upgrade toast once per launch. */
export const MIN_DAEMON_VERSION = '0.8.0';

/**
 * Rendering capabilities this client supports, in settings order; the enabled ones are declared to the host,
 * which teaches agents the matching skill (e.g. `agentdeck-chart`).
 */
export const SUPPORTED_SKILLS = [
  'widget',
  'chart',
  'map',
  ...(previewSupported ? ['preview', 'app'] : []),
  'screen',
  'session',
  ...(calendarSupported ? ['event'] : []),
];

/** Skills that only work with another one, e.g. built apps open through `agentdeck-preview`; off with it. */
export const SKILL_REQUIRES: Record<string, string> = { app: 'preview' };

export type AgentInfo = { id: string; name: string };

// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
// `free` is the daemon's built-in agent (OpenCode free models), first so it is the default; hosts' custom agents follow it.
export const defaultAgents: AgentInfo[] = [
  { id: 'free', name: 'Free' },
  { id: 'claude-acp', name: 'Claude Code' },
  { id: 'codex-acp', name: 'Codex' },
  { id: 'github-copilot-cli', name: 'GitHub Copilot' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'antigravity-acp', name: 'Google Antigravity' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'qwen-code', name: 'Qwen Code' },
  { id: 'kimi', name: 'Kimi CLI' },
  { id: 'junie', name: 'Junie' },
  { id: 'grok-build', name: 'Grok Build' },
  { id: 'codebuddy-code', name: 'CodeBuddy Code' },
  { id: 'qoder', name: 'Qoder CLI' },
  { id: 'pi-acp', name: 'Pi' },
];

export const isRelayUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !!url.host;
  } catch {
    return false;
  }
};

/** Saved per agent: the chosen config options and the latest slash commands. */
export type AgentDefaults = SessionOptions & { commands?: AvailableCommand[] };

export const readConfigDefaults = (): Record<string, AgentDefaults> => {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_DEFAULTS_KEY) || '{}') ?? {};
  } catch {
    return {};
  }
};

export const readSavedCommands = () =>
  Object.fromEntries(
    Object.entries(readConfigDefaults()).flatMap(([agent, { commands }]) => (commands ? [[agent, commands]] : [])),
  ) as Record<string, AvailableCommand[]>;

/** A pairing whose host handshake succeeded; `hostname` is missing for old daemons. */
export type PairingRecord = {
  relayId: string;
  relayUrl?: string;
  hostname?: string;
  home?: string;
  /** From `custom_agents.json` on the host. */
  customAgents?: AgentInfo[];
  /** Agent last chosen for this host. */
  agent?: string;
};

/** Most recently connected first. */
export const readPairingHistory = (): PairingRecord[] => {
  try {
    const value = JSON.parse(localStorage.getItem(PAIRING_HISTORY_KEY) || '[]');
    return Array.isArray(value)
      ? value.filter((item) => typeof item?.relayId === 'string' && isPairingId(item.relayId))
      : [];
  } catch {
    return [];
  }
};

export const readDisabledSkills = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(DISABLED_SKILLS_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

export const readSettings = (): AppSettings => {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') as Partial<AppSettings> | null;
    const relayId = typeof value?.relayId === 'string' && isPairingId(value.relayId) ? value.relayId : '';
    return {
      relayId,
      agent: typeof value?.agent === 'string' && value.agent ? value.agent : defaultAgents[0].id,
      relayUrl: typeof value?.relayUrl === 'string' && isRelayUrl(value.relayUrl) ? value.relayUrl : '',
    };
  } catch {
    return { relayId: '', agent: defaultAgents[0].id, relayUrl: '' };
  }
};
