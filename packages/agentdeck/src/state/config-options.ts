import { Toast } from '@mantou/tap-ui/elements/toast';
import { agentApi } from '../agent/transport';
import { CONFIG_DEFAULTS_KEY } from '../config';
import { i18n } from '../i18n';
import { type ConfigSelect, getConfigSelects, withConfigValue, withCurrentMode } from '../session/config-options';
import type { DeckSession, SessionOptions } from '../session/types';
import { agentdeckStore, updateSessionOptions } from './store';

const readConfigDefaults = (): Record<string, SessionOptions> => {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_DEFAULTS_KEY) || '{}') ?? {};
  } catch {
    return {};
  }
};

export const getConfigDefaults = (agent: string): SessionOptions => readConfigDefaults()[agent] ?? {};

/** Remember full option set per agent so new sessions can display and reuse them without first loading a session of the same agent. */
export const saveConfigDefaults = (agent: string, options: SessionOptions) => {
  if (!getConfigSelects(options).length) return;
  const { modes, configOptions } = options;
  localStorage.setItem(
    CONFIG_DEFAULTS_KEY,
    JSON.stringify({ ...readConfigDefaults(), [agent]: { modes, configOptions } }),
  );
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
 * Apply selections from a pending-creation session item-by-item to the newly created remote session; skip items or values no longer supported by remote.
 * Uses the session-creation timeout: the agent may still be starting up and handle these requests only after it is ready.
 */
export const applyConfigSelection = async (session: DeckSession, created: SessionOptions, selected: SessionOptions) => {
  let options = created;
  for (const { id, currentValue } of getConfigSelects(selected)) {
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
