import { addListener } from '@mantou/gem/lib/utils';
import { isPairingId } from 'agentdeck/agent/encryption';
import { addTransportMessageHandler, agentApi, startTransport } from 'agentdeck/agent/transport';
import { observeAgentPanelState, readAgentPanelState } from '../../shared/agent-session-store.js';
import { createChromeStorageStore, getExtensionDeviceId } from '../../shared/agent-storage.js';

export async function startExtensionTransport(relayId) {
  const deviceId = await getExtensionDeviceId();
  startTransport(relayId, {
    deviceId,
    createStore: (routeId) => createChromeStorageStore(routeId, undefined, () => deviceId),
  });
}

/** Load the data required before the panel leaves its initial full-page loader. */
export function mountBootstrap({ state }) {
  let active = true;
  const update = (patch) => active && state(patch);

  (async () => {
    try {
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
      }
    } finally {
      update({ booting: false });
    }
  })();

  return () => {
    active = false;
  };
}

export function mountStoredState(state) {
  return observeAgentPanelState(({ sessions, defaults, relayId }) => state({ sessions, defaults, relayId }));
}

export function mountCompactMode(state) {
  const mediaQuery = matchMedia('(width <= 1280px)');
  state({ compact: mediaQuery.matches });
  return addListener(mediaQuery, 'change', ({ matches }) => state({ compact: matches }));
}

export function mountAgentApi({ sessions, turns, state }) {
  agentApi.setPermissionHandler(turns.requestPermission);
  agentApi.setSessionEndedHandler(sessions.handleSessionEnded);
  agentApi.setHostReconnectedHandler(sessions.handleHostReconnect);

  const unsubscribeTransport = addTransportMessageHandler(async (message) => {
    switch (message.type) {
      case 'connection': {
        const { connection, error } = message;
        if (connection === 'connected') {
          state?.({ error: '' });
          try {
            const { value } = await agentApi.completeCwd('');
            if (value) state?.({ home: value });
          } catch {}
        } else if (connection === 'unavailable' || connection === 'disconnected' || connection === 'preempted') {
          if (error) state?.({ error });
        }
        break;
      }
      case 'delivery_error': {
        if (message.error) state?.({ error: message.error });
        break;
      }
      case 'session_ended': {
        sessions.handleSessionEnded(message);
        break;
      }
    }
  });

  return () => {
    unsubscribeTransport?.();
    turns.declineAllPermissions();
    agentApi.setPermissionHandler(null);
    agentApi.setSessionEndedHandler(null);
    agentApi.setHostReconnectedHandler(null);
  };
}
