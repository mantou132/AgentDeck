import { isRelayId } from 'relay-client-ts';
import type { RemoteAgent } from './agent/api';

export type AppSettings = {
  relayId: string;
  agent: string;
};

export const SETTINGS_KEY = 'agentdeck.settings.v1';
export const DEVICE_ID_KEY = 'agentdeck.device_id.v1';
export const RESET_PENDING_KEY = 'agentdeck.reset_pending.v1';
export const RELAY_URL =
  process.env.NODE_ENV === 'development' ? 'ws://192.168.77.137:39371/ws' : 'wss://agent-deck.xianqiao.wang/ws';

export const fallbackAgents: RemoteAgent[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'pi', name: 'pi' },
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
