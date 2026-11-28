import { Toast } from '@mantou/tap-ui/elements/toast';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import { DEFAULT_STORAGE_KEY } from 'relay-client-ts';
import type { ClientSkills } from 'src/agent/api';
import { isPairingId } from 'src/agent/encryption';
import {
  clearTransportStorage,
  initTransport,
  startTransport,
  type TransportMessage,
  updateTransportSkills,
} from 'src/agent/transport';
import { clearDrafts } from 'src/composer/drafts';
import {
  type AppLanguage,
  type AppSettings,
  LANGUAGE_KEY,
  MIN_DAEMON_VERSION,
  PAIRING_HISTORY_KEY,
  type PairingRecord,
  RESET_PENDING_KEY,
  SETTINGS_KEY,
  SKILL_TOGGLES_KEY,
  SUPPORTED_SKILLS,
} from 'src/config';
import { i18n } from 'src/i18n';
import { loadSkills, skillGroups, skillsHash } from 'src/skills';
import {
  endSession,
  handleSessionDeleted,
  handleSessionEvent,
  handleSessionState,
  handleSessionUnread,
  handleUserInputResolved,
  markAllUnsubscribed,
  refreshSessions,
  resetRemoteState,
  resetSessionList,
  resyncOpenSessions,
  showUserInput,
  syncActiveSessions,
} from 'src/state/sessions';
import { agentdeckStore, isSkillEnabled, isTurnRunning, sessionsStore, updateRuntime } from 'src/state/store';
import { refreshTasks, resetTasks } from 'src/state/tasks';

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

const clientSkills = (): ClientSkills => ({
  hash: skillsHash,
  enabled: SUPPORTED_SKILLS.filter(isSkillEnabled),
  groups: skillGroups,
  load: loadSkills,
});

const savePairingHistory = (pairingHistory: PairingRecord[]) => {
  localStorage.setItem(PAIRING_HISTORY_KEY, JSON.stringify(pairingHistory));
  agentdeckStore({ pairingHistory });
};

type HostInfo = Pick<PairingRecord, 'hostname' | 'home' | 'customAgents' | 'restrictedFeatures'>;

/** Moves the connected pairing to the front; keeps the known hostname when an old daemon omits it. */
const recordPairing = ({ hostname, home, customAgents, restrictedFeatures }: HostInfo) => {
  const { relayId, relayUrl, agent } = agentdeckStore.settings;
  const previous = agentdeckStore.pairingHistory.find((item) => item.relayId === relayId);
  const rest = agentdeckStore.pairingHistory.filter((item) => item !== previous);
  savePairingHistory([
    { relayId, relayUrl, hostname: hostname || previous?.hostname, home, customAgents, restrictedFeatures, agent },
    ...rest,
  ]);
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
      const { connection, error, hostVersion, hostname, home, customAgents, restrictedFeatures } = message;
      agentdeckStore({
        connection,
        connectionError: connection === 'connected' ? '' : error || agentdeckStore.connectionError,
      });
      if (connection === 'connected') {
        agentdeckStore({ hostVersion: hostVersion || '' });
        recordPairing({ hostname, home, customAgents, restrictedFeatures });
        refreshSessions();
        refreshTasks();
        syncActiveSessions().catch(console.error);
        resyncOpenSessions();
        if (!daemonVersionChecked) {
          daemonVersionChecked = true;
          if (isDaemonOutdated(hostVersion)) Toast.open('warning', i18n.get('error.daemonOutdated'));
        }
      } else {
        markAllUnsubscribed();
      }
      break;
    }
    case 'session_event': {
      handleSessionEvent(message.sessionId, message.epoch, message.event);
      break;
    }
    case 'session_state': {
      handleSessionState(message.state);
      break;
    }
    case 'user_input_resolved': {
      handleUserInputResolved(message.sessionId, message.requestId);
      break;
    }
    case 'session_ended': {
      endSession(message.sessionId);
      break;
    }
    case 'session_deleted': {
      handleSessionDeleted(message.sessionId);
      break;
    }
    case 'session_unread': {
      handleSessionUnread(message.agent, message.sessionId, message.unread);
      break;
    }
    case 'prompt_suggestion': {
      // Suggestions arriving after turn completion are not needed by any newly started turn
      if (!isTurnRunning(message.sessionId)) updateRuntime(message.sessionId, { suggestion: message.suggestion });
      break;
    }
  }
};

export const startApp = async () => {
  // The Relay store moved to IndexedDB; in-flight state and session metadata moved to the daemon.
  localStorage.removeItem(DEFAULT_STORAGE_KEY);
  localStorage.removeItem('agentdeck.meta.v1');
  if (typeof indexedDB?.deleteDatabase === 'function') indexedDB.deleteDatabase('agentdeck-in-flight');
  try {
    if (sessionStorage.getItem(RESET_PENDING_KEY)) {
      clearDrafts().catch(console.error);
      // The transport must not start before the old outbox is gone, or it would replay it.
      await clearTransportStorage();
      sessionStorage.removeItem(RESET_PENDING_KEY);
    }
  } catch (error) {
    agentdeckStore({ connection: 'disconnected' });
    sessionsStore({
      sessionsLoaded: true,
      sessionsError: getStringFromTemplate(
        i18n.get('error.resetLocalFailed', error instanceof Error ? error.message : String(error)),
      ),
    });
    return;
  }

  initTransport({
    initialRelayId: agentdeckStore.settings.relayId,
    initialRelayUrl: agentdeckStore.settings.relayUrl,
    ackHead: true,
    skills: clientSkills(),
    onUserInput: showUserInput,
    onMessage: handleTransportMessage,
  });
};

/** Takes effect immediately: the host is told again, and sessions created or loaded afterwards use it. */
export const setSkillEnabled = (skill: string, enabled: boolean) => {
  const skillToggles = { ...agentdeckStore.skillToggles, [skill]: enabled };
  localStorage.setItem(SKILL_TOGGLES_KEY, JSON.stringify(skillToggles));
  agentdeckStore({ skillToggles });
  updateTransportSkills(clientSkills());
};

export const setLanguage = async (language: AppLanguage) => {
  if (language) localStorage.setItem(LANGUAGE_KEY, language);
  else localStorage.removeItem(LANGUAGE_KEY);
  agentdeckStore({ language });
  await (language ? i18n.setLanguage(language) : i18n.resetLanguage());
};

/** Saves settings and switches transport when needed. Returns whether the host/relay changed. */
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
  if (agentChanged) {
    savePairingHistory(
      agentdeckStore.pairingHistory.map((item) =>
        item.relayId === next.relayId ? { ...item, agent: next.agent } : item,
      ),
    );
  }
  if (relayChanged) {
    resetRemoteState();
    resetTasks();
  } else if (agentChanged) resetSessionList();
  const { relayUrl } = next;
  if (relayChanged) startTransport(next.relayId, { ackHead: true, relayUrl, skills: clientSkills() });
  else if (notConnected) startTransport(next.relayId, { ackHead: true, relayUrl, skills: clientSkills() });
  else if (agentChanged && agentdeckStore.connection === 'connected') {
    refreshSessions();
    syncActiveSessions().catch(console.error);
  }
  return relayChanged;
};

/**
 * Reloads the entire App, terminating connections, callbacks, pending permissions, and Stack pages in the old document.
 * Pairing settings are preserved; Relay cache is cleared upon restart without cancelling or closing remote sessions.
 */
export const hardResetApp = () => {
  sessionStorage.setItem(RESET_PENDING_KEY, 'true');
  window.location.reload();
};
