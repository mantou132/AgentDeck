import { addListener } from '@mantou/gem/lib/utils';
import { isPairingId } from 'agentdeck/agent/encryption';
import { addTransportMessageHandler, agentApi, startTransport } from 'agentdeck/agent/transport';
import { observeAgentPanelState, readAgentPanelState } from '../../shared/agent-session-store';
import { createChromeStorageStore, getExtensionDeviceId } from '../../shared/agent-storage';
import type { SessionController } from './session-controller';
import type { TurnController } from './turn-controller';
import type { PanelStore } from './types';

export async function startExtensionTransport(relayId: string) {
  const deviceId = await getExtensionDeviceId();
  startTransport(relayId, {
    deviceId,
    createStore: (routeId) => createChromeStorageStore(routeId, deviceId),
  });
}

/** Load the data required before the panel leaves its initial full-page loader. */
export function mountBootstrap(state: PanelStore) {
  let active = true;
  const update: PanelStore = ((patch) => active && state(patch)) as PanelStore;

  (async () => {
    try {
      const stored = await readAgentPanelState();
      update({
        sessions: stored.sessions,
        defaults: stored.defaults,
        relayId: stored.relayId,
      });
      if (stored.relayId && isPairingId(stored.relayId)) {
        await startExtensionTransport(stored.relayId);
      } else {
        update({ settingsOpen: true });
      }
    } catch (e) {
      update({ error: e.message });
    } finally {
      update({ booting: false });
    }
  })();

  return () => {
    active = false;
  };
}

export function mountStoredState(state: PanelStore) {
  return observeAgentPanelState(({ sessions, defaults, relayId }) => state({ sessions, defaults, relayId }));
}

export function mountCompactMode(state: PanelStore) {
  const mediaQuery = matchMedia('(width <= 1280px)');
  state({ compact: mediaQuery.matches });
  return addListener(mediaQuery, 'change', ({ matches }: MediaQueryListEvent) => state({ compact: matches }));
}

type MountAgentApiOptions = {
  sessions: SessionController;
  turns: TurnController;
  state: PanelStore;
};

export function mountAgentApi({ sessions, turns, state }: MountAgentApiOptions) {
  agentApi.setUserInputHandler(turns.handleUserInput);
  agentApi.setSessionEndedHandler(sessions.handleSessionEnded);
  agentApi.setHostReconnectedHandler(sessions.handleHostReconnect);

  const unsubscribeTransport = addTransportMessageHandler((message) => {
    if (message.type === 'delivery_error') {
      state({ error: message.error });
    } else if (message.type === 'connection') {
      const { connection, error, home } = message;
      if (connection === 'connected') {
        state({ error: '', ...(home && { home }) });
      } else if (error && ['unavailable', 'disconnected', 'preempted'].includes(connection)) {
        state({ error });
      }
    }
  });

  return () => {
    unsubscribeTransport();
    turns.declineAllPermissions();
    agentApi.setUserInputHandler(null);
    agentApi.setSessionEndedHandler(null);
    agentApi.setHostReconnectedHandler(null);
  };
}
