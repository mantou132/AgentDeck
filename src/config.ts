import { isRelayId } from 'relay-client-ts';

export type AppSettings = {
  relayId: string;
  agent: string;
};

export const SETTINGS_KEY = 'agentdeck.settings.v1';
export const DEVICE_ID_KEY = 'agentdeck.device_id.v1';
export const RESET_PENDING_KEY = 'agentdeck.reset_pending.v1';
export const RELAY_GUIDE_SEEN_KEY = 'agentdeck.relay_guide_seen.v1';
export const RELAY_URL =
  process.env.NODE_ENV === 'development' ? 'ws://192.168.77.137:39371/ws' : 'wss://agent-deck.xianqiao.wang/ws';

// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
export const popularAgents: { id: string; name: string }[] = [
  { id: 'claude-acp', name: 'Claude Code' },
  { id: 'codex-acp', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'pi-acp', name: 'pi' },
  { id: 'gemini', name: 'Gemini CLI' },
  { id: 'antigravity-acp', name: 'Google Antigravity' },
  { id: 'github-copilot-cli', name: 'GitHub Copilot' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'qwen-code', name: 'Qwen Code' },
  { id: 'kimi', name: 'Kimi CLI' },
];

export const readSettings = (): AppSettings => {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') as Partial<AppSettings> | null;
    const relayId = typeof value?.relayId === 'string' && isRelayId(value.relayId) ? value.relayId : '';
    return {
      relayId,
      agent: typeof value?.agent === 'string' && value.agent ? value.agent : 'codex',
    };
  } catch {
    return { relayId: '', agent: 'codex' };
  }
};
