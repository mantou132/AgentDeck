import { Toast } from '@mantou/tap-ui/elements/toast';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import { isPairingId } from '../agent/encryption';
import { clearTransportStorage, initTransport, startTransport, type TransportMessage } from '../agent/transport';
import { clearDrafts } from '../composer/drafts';
import {
  type AppSettings,
  MIN_DAEMON_VERSION,
  PAIRING_HISTORY_KEY,
  type PairingRecord,
  RENDER_CAPABILITIES,
  RESET_PENDING_KEY,
  SETTINGS_KEY,
} from '../config';
import { i18n } from '../i18n';
import { clearAllInFlight, getAllInFlight, hasActiveInFlightMarker } from './in-flight';
import {
  applySessionEvent,
  endSession,
  recordInFlightSession,
  refreshSessions,
  resetRemoteState,
  resumeInFlightTurn,
  settleLostTurns,
  showUserInput,
} from './sessions';
import { agentdeckStore, setPromptSuggestion } from './store';

/** Older daemon versions that do not report a version are also considered outdated; prerelease suffixes are ignored in comparison */
const isDaemonOutdated = (version?: string) => {
  if (!version) return true;
  const parse = (value: string) => value.split('-')[0].split('.').map(Number);
  const current = parse(version);
  const min = parse(MIN_DAEMON_VERSION);
  for (let i = 0; i < min.length; i++) {
    if (current[i] !== min[i]) return current[i] < min[i];
  }
  return false;
};

let daemonVersionChecked = false;

const savePairingHistory = (pairingHistory: PairingRecord[]) => {
  localStorage.setItem(PAIRING_HISTORY_KEY, JSON.stringify(pairingHistory));
  agentdeckStore({ pairingHistory });
};

/** Moves the connected pairing to the front; keeps the known hostname when an old daemon omits it. */
const recordPairing = (hostname?: string, home?: string) => {
  const { relayId, relayUrl } = agentdeckStore.settings;
  const previous = agentdeckStore.pairingHistory.find((item) => item.relayId === relayId);
  const rest = agentdeckStore.pairingHistory.filter((item) => item !== previous);
  savePairingHistory([{ relayId, relayUrl, hostname: hostname || previous?.hostname, home }, ...rest]);
};

export const removePairing = (relayId: string) =>
  savePairingHistory(agentdeckStore.pairingHistory.filter((item) => item.relayId !== relayId));

/**
 * Single underlying message consumption hub:
 * WebSocket connection and App state are fully decoupled; App responds to state and messages only at this single point.
 */
const handleTransportMessage = (message: TransportMessage) => {
  switch (message.type) {
    case 'delivery_error': {
      agentdeckStore({ connectionError: message.error });
      break;
    }
    case 'connection': {
      const { connection, error, hostVersion, hostname, home } = message;
      agentdeckStore({
        connection,
        connectionError: connection === 'connected' ? '' : error || agentdeckStore.connectionError,
      });
      if (connection === 'connected') {
        agentdeckStore({ hostVersion: hostVersion || '' });
        recordPairing(hostname, home);
        refreshSessions();
        // Older daemon has no reconciliation endpoint; stay waiting if it fails
        settleLostTurns().catch(console.error);
        if (!daemonVersionChecked) {
          daemonVersionChecked = true;
          if (isDaemonOutdated(hostVersion)) Toast.open('warning', i18n.get('error.daemonOutdated'));
        }
      }
      break;
    }
    case 'session_event': {
      applySessionEvent(message.sessionId, message.event);
      break;
    }
    case 'session_ended': {
      endSession(message.sessionId);
      break;
    }
    case 'prompt_suggestion': {
      // Suggestions arriving after turn completion are not needed by any newly started turn
      if (!agentdeckStore.pendingSessionIds.includes(message.sessionId))
        setPromptSuggestion(message.sessionId, message.suggestion);
      break;
    }
  }
};

export const startApp = () => {
  let resetWasPending = false;
  try {
    if (sessionStorage.getItem(RESET_PENDING_KEY)) {
      resetWasPending = true;
      // Clear after reload: callbacks in the old document can no longer refill the outbox.
      clearTransportStorage();
      clearAllInFlight();
      clearDrafts().catch(console.error);
      sessionStorage.removeItem(RESET_PENDING_KEY);
    }
  } catch (error) {
    agentdeckStore({
      connection: 'disconnected',
      sessionsLoaded: true,
      sessionsError: getStringFromTemplate(
        i18n.get('error.resetLocalFailed', error instanceof Error ? error.message : String(error)),
      ),
    });
    return;
  }

  const restoreInFlights = getAllInFlight()
    .then((inFlights) => {
      if (!inFlights.length) return;
      const messagesBySession = { ...agentdeckStore.messagesBySession };
      const optionsBySession = { ...agentdeckStore.optionsBySession };
      const pendingSessionIds = [...agentdeckStore.pendingSessionIds];
      const loadedSessionIds = [...agentdeckStore.loadedSessionIds];

      for (const item of inFlights) {
        messagesBySession[item.sessionId] = item.messages;
        if (item.options) optionsBySession[item.sessionId] = item.options;
        if (!pendingSessionIds.includes(item.sessionId)) pendingSessionIds.push(item.sessionId);
        if (!loadedSessionIds.includes(item.sessionId)) loadedSessionIds.push(item.sessionId);
        const effectiveUpdatedAt =
          item.session.updatedAt ||
          (item.updatedAt ? new Date(item.updatedAt).toISOString() : new Date().toISOString());
        recordInFlightSession({ ...item.session, updatedAt: effectiveUpdatedAt });
        resumeInFlightTurn(item);
      }

      agentdeckStore({
        messagesBySession,
        optionsBySession,
        pendingSessionIds,
        loadedSessionIds,
      });
    })
    .catch((error) => {
      console.error('Failed to restore in-flight sessions:', error);
    });

  const shouldAckHead = resetWasPending || !hasActiveInFlightMarker();
  initTransport({
    initialRelayId: agentdeckStore.settings.relayId,
    initialRelayUrl: agentdeckStore.settings.relayUrl,
    ackHead: shouldAckHead,
    capabilities: RENDER_CAPABILITIES,
    onUserInput: showUserInput,
    onMessage: handleTransportMessage,
    onBeforePayload: () => restoreInFlights,
  });
};

export const saveSettings = (settings: AppSettings) => {
  const next = { relayId: settings.relayId.trim(), agent: settings.agent.trim(), relayUrl: settings.relayUrl || '' };
  if (!isPairingId(next.relayId)) throw new Error(i18n.get('error.invalidRelayId'));
  if (!next.agent) throw new Error(i18n.get('error.selectRemoteAgent'));
  const relayChanged =
    next.relayId !== agentdeckStore.settings.relayId || next.relayUrl !== agentdeckStore.settings.relayUrl;
  const agentChanged = next.agent !== agentdeckStore.settings.agent;
  const notConnected = agentdeckStore.connection !== 'connected';
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  agentdeckStore({ settings: next, connectionError: '' });
  if (relayChanged || agentChanged) {
    resetRemoteState();
  }
  const { relayUrl } = next;
  if (relayChanged) startTransport(next.relayId, { ackHead: true, relayUrl, capabilities: RENDER_CAPABILITIES });
  else if (notConnected) startTransport(next.relayId, { relayUrl, capabilities: RENDER_CAPABILITIES });
  else if (agentChanged && agentdeckStore.connection === 'connected') refreshSessions();
};

/**
 * Reloads the entire App, terminating connections, callbacks, pending permissions, and Stack pages in the old document.
 * Pairing settings are preserved; Relay cache and unresolved sessions are cleared upon restart without waiting for remote cancellation or closure.
 */
export const hardResetApp = () => {
  sessionStorage.setItem(RESET_PENDING_KEY, 'true');
  window.location.reload();
};
