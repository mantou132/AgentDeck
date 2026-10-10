import { Toast } from '@mantou/tap-ui/elements/toast';
import type { AvailableCommand } from '../agent/api';
import { agentApi } from '../agent/transport';
import { type AgentDefaults, CONFIG_DEFAULTS_KEY, readConfigDefaults } from '../config';
import { i18n } from '../i18n';
import { type ConfigSelect, getConfigSelects, withConfigValue, withCurrentMode } from '../session/config-options';
import type { DeckSession, SessionOptions } from '../session/types';
import { agentdeckStore, updateSessionOptions } from './store';

const saveAgentDefaults = (agent: string, patch: AgentDefaults) => {
  const defaults = readConfigDefaults();
  localStorage.setItem(CONFIG_DEFAULTS_KEY, JSON.stringify({ ...defaults, [agent]: { ...defaults[agent], ...patch } }));
};

export const getConfigDefaults = (agent: string): SessionOptions => {
  const { modes, configOptions } = readConfigDefaults()[agent] ?? {};
  return { modes, configOptions };
};

/** Remember full option set per agent so new sessions can display and reuse them without first loading a session of the same agent. */
export const saveConfigDefaults = (agent: string, options: SessionOptions) => {
  if (!getConfigSelects(options).length) return;
  const { modes, configOptions } = options;
  saveAgentDefaults(agent, { modes, configOptions });
};

/** The latest commands an agent announced; new sessions offer them before their own list arrives. */
export const setAgentCommands = (agent: string, commands: AvailableCommand[]) => {
  agentdeckStore({ commandsByAgent: { ...agentdeckStore.commandsByAgent, [agent]: commands } });
  saveAgentDefaults(agent, { commands });
};

const applyRemoteConfig = async (
  session: DeckSession,
  options: SessionOptions,
  select: ConfigSelect,
  value: string,
  timeoutMs?: number,
): Promise<SessionOptions> => {
  if (select.legacyMode) {
    await agentApi.setSessionMode(session.agent, session.sessionId, value, timeoutMs);
    return withCurrentMode(options, value);
  }
  const { configOptions } = await agentApi.setSessionConfigOption(
    session.agent,
    session.sessionId,
    select.id,
    value,
    timeoutMs,
  );
  return { ...options, configOptions };
};

/**
 * Apply selections (config id → value) item-by-item to a newly created or loaded remote session; skip items or values no longer supported by remote.
 * Uses the session-creation timeout: the agent may still be starting up and handle these requests only after it is ready.
 */
export const applyConfigSelection = async (
  session: DeckSession,
  remote: SessionOptions,
  selected: Record<string, string>,
) => {
  let options = remote;
  for (const [id, currentValue] of Object.entries(selected)) {
    const select = getConfigSelects(options).find((item) => item.id === id);
    if (!select || select.currentValue === currentValue) continue;
    if (!select.choices.some((choice) => choice.value === currentValue)) continue;
    options = await applyRemoteConfig(session, options, select, currentValue, 65_000);
  }
  return options;
};

/** Selection takes effect immediately; warns and rolls back to previous value if remote call fails. */
export const changeSessionConfig = async (session: DeckSession, configId: string, value: string) => {
  const { sessionId } = session;
  const select = getConfigSelects(agentdeckStore.optionsBySession[sessionId]).find((item) => item.id === configId);
  if (!select) return false;
  if (select.currentValue === value) return true;
  if (!session.pendingCreation) {
    if (agentdeckStore.connection !== 'connected' || !agentdeckStore.loadedSessionIds.includes(sessionId)) return false;
  }
  const next = withConfigValue(agentdeckStore.optionsBySession[sessionId], select, value);
  updateSessionOptions(sessionId, next);
  if (session.pendingCreation) {
    saveConfigDefaults(session.agent, next);
    return true;
  }
  try {
    updateSessionOptions(sessionId, await applyRemoteConfig(session, next, select, value));
    saveConfigDefaults(session.agent, agentdeckStore.optionsBySession[sessionId]);
    return true;
  } catch (error) {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('error.switchConfigFailed'));
    const options = agentdeckStore.optionsBySession[sessionId];
    // Keep the new selection if another value was chosen in the meantime
    if (getConfigSelects(options).find((item) => item.id === configId)?.currentValue === value) {
      updateSessionOptions(sessionId, withConfigValue(options, select, select.currentValue));
    }
    return false;
  }
};
