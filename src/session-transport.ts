import { isRelayId, RelayClient, type RelayConnectionState } from 'relay-client-ts';
import { AgentApi, type PermissionRequest } from './agent-api';
import { DEVICE_ID_KEY, RELAY_URL } from './session-runtime';

export const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

let currentPeerId: number | undefined;
export const setPeerId = (id: number | undefined) => {
  currentPeerId = id;
};
export const getPeerId = () => currentPeerId;

let relayClient: RelayClient | undefined;

export const agentApi = new AgentApi((message) => {
  if (!relayClient) throw new Error('Relay 尚未配置');
  if (currentPeerId !== undefined) {
    (message as Record<string, unknown>).peerId = currentPeerId;
  }
  relayClient.send(message);
});

export type TransportHandlers = {
  onStateChange: (connection: RelayConnectionState, error?: string) => void;
  onConnected: () => void;
};

export const startRelay = (relayId: string, handlers: TransportHandlers) => {
  relayClient?.close();
  relayClient = new RelayClient({
    relayId,
    endpoint: '2',
    relayUrl: RELAY_URL,
    onPayload: (payload) => {
      const data = payload as Record<string, unknown>;
      if (typeof data?.peerId === 'number' && currentPeerId !== undefined) {
        if (data.peerId !== currentPeerId) {
          // Message belongs to another device on this relay; ignore.
          return;
        }
      }
      agentApi.dispatch(payload as Parameters<AgentApi['dispatch']>[0]);
    },
    onDisconnect: (error) => {
      currentPeerId = undefined;
      agentApi.rejectAll(error);
    },
    onStateChange: (connection, connectionError = '') => {
      handlers.onStateChange(connection, connectionError);
      if (connection === 'connected') {
        handlers.onConnected();
      }
    },
  });
  relayClient.connect();
};

export const closeRelay = () => {
  relayClient?.close();
  relayClient = undefined;
  currentPeerId = undefined;
};

export const syncHostConnection = async (onRefreshSessions?: () => Promise<void>) => {
  try {
    const res = await agentApi.attachPeer(getDeviceId());
    if (typeof res?.peerId === 'number') {
      setPeerId(res.peerId);
    }
  } catch (e) {
    console.warn('Failed to attach peer ID:', e);
  }
  await onRefreshSessions?.();
};

let appStarted = false;
export const initAppTransport = (options: {
  initialRelayId: string;
  onRequestPermission: (request: PermissionRequest) => Promise<string>;
  onSessionEnded: (sessionId: string) => void;
  onHostReconnected: () => void;
  transportHandlers: TransportHandlers;
}) => {
  if (appStarted) return;
  appStarted = true;
  agentApi.setPermissionHandler(options.onRequestPermission);
  agentApi.setSessionEndedHandler(({ sessionId }) => {
    options.onSessionEnded(sessionId);
  });
  agentApi.setHostReconnectedHandler(() => {
    options.onHostReconnected();
  });
  if (isRelayId(options.initialRelayId)) {
    startRelay(options.initialRelayId, options.transportHandlers);
  }
};
