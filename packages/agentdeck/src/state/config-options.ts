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

/** 按 agent 记住整组选项，新会话不必先加载同 agent 的会话就能展示并沿用。 */
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
): Promise<SessionOptions> => {
  if (select.legacyMode) {
    await agentApi.setSessionMode(session.agent, session.sessionId, value);
    return withCurrentMode(options, value);
  }
  const { configOptions } = await agentApi.setSessionConfigOption(session.agent, session.sessionId, select.id, value);
  return { ...options, configOptions };
};

/** 把待创建会话上的选择逐项应用到刚创建的远端会话；远端不再支持的项或值跳过。 */
export const applyConfigSelection = async (session: DeckSession, created: SessionOptions, selected: SessionOptions) => {
  let options = created;
  for (const { id, currentValue } of getConfigSelects(selected)) {
    const select = getConfigSelects(options).find((item) => item.id === id);
    if (!select || select.currentValue === currentValue) continue;
    if (!select.choices.some((choice) => choice.value === currentValue)) continue;
    options = await applyRemoteConfig(session, options, select, currentValue);
  }
  return options;
};

/** 选择立即生效；远端失败时提示并回退到选择前的值。 */
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
    // 之后又选了别的值时保留新选择
    if (getConfigSelects(options).find((item) => item.id === configId)?.currentValue === value) {
      updateSessionOptions(sessionId, withConfigValue(options, select, select.currentValue));
    }
    return false;
  }
};
