import type { AvailableCommand, ClientCapabilities } from './agent/api';
import { isPairingId } from './agent/encryption';
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

// IndexedDB database names are unique within this app's origin.
// Keep all database/store identities here; retain existing names for persisted data.
export const DATABASES = {
  inFlight: { name: 'agentdeck-db', version: 1, storeName: 'in_flight_sessions', keyPath: 'sessionId' },
  drafts: { name: 'agentdeck-drafts', version: 1, storeName: 'drafts' },
} as const;

export const RELAY_URL = 'wss://agent-deck.xianqiao.wang/ws';
export const FEEDBACK_URL = 'https://github.com/mantou132/AgentDeck/issues/new';

/** Raise when the app needs a newer agentdeckd; older hosts get an upgrade toast once per launch. */
export const MIN_DAEMON_VERSION = '0.4.0';

/** Markdown blocks this client renders; the host teaches agents to write them (e.g. `agentdeck-chart`). */
export const RENDER_CAPABILITIES: ClientCapabilities = {
  render: previewSupported ? ['chart', 'map', 'preview', 'screen'] : ['chart', 'map', 'screen'],
};

// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
// `free` is the daemon's built-in agent (OpenCode free models), first so it is the default.
export const popularAgents: { id: string; name: string }[] = [
  { id: 'free', name: 'Free' },
  { id: 'claude-acp', name: 'Claude Code' },
  { id: 'codex-acp', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'pi-acp', name: 'Pi' },
  { id: 'antigravity-acp', name: 'Google Antigravity' },
  { id: 'github-copilot-cli', name: 'GitHub Copilot' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'qwen-code', name: 'Qwen Code' },
  { id: 'kimi', name: 'Kimi CLI' },
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
export type PairingRecord = { relayId: string; relayUrl?: string; hostname?: string };

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

export const readSettings = (): AppSettings => {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') as Partial<AppSettings> | null;
    const relayId = typeof value?.relayId === 'string' && isPairingId(value.relayId) ? value.relayId : '';
    return {
      relayId,
      agent: typeof value?.agent === 'string' && value.agent ? value.agent : popularAgents[0].id,
      relayUrl: typeof value?.relayUrl === 'string' && isRelayUrl(value.relayUrl) ? value.relayUrl : '',
    };
  } catch {
    return { relayId: '', agent: popularAgents[0].id, relayUrl: '' };
  }
};
