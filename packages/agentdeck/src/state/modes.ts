import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { getModeSelection, withCurrentMode } from '../session/modes';
import type { DeckSession, SessionOptions } from '../session/types';
import { agentdeckStore, setSessionError, setSessionFlag, updateSessionOptions } from './store';

export const applyRemoteMode = async (
  session: DeckSession,
  options: SessionOptions,
  modeId: string,
): Promise<SessionOptions> => {
  const mode = getModeSelection(options);
  if (!mode?.choices.some((choice) => choice.value === modeId)) {
    throw new Error(i18n.get('error.unsupportedMode'));
  }
  if (mode.currentValue === modeId) return options;
  if (mode.configId) {
    return agentApi.setSessionModeOption(session.agent, session.sessionId, mode.configId, modeId);
  }
  await agentApi.setSessionMode(session.agent, session.sessionId, modeId);
  return withCurrentMode(options, modeId);
};

export const changeSessionMode = async (session: DeckSession, modeId: string) => {
  const { sessionId } = session;
  const options = agentdeckStore.optionsBySession[sessionId];
  if (!options || agentdeckStore.changingModeSessionIds.includes(sessionId)) return false;
  if (session.draft) {
    updateSessionOptions(sessionId, withCurrentMode(options, modeId));
    return true;
  }
  if (agentdeckStore.connection !== 'connected' || !agentdeckStore.loadedSessionIds.includes(sessionId)) return false;
  setSessionFlag('changingModeSessionIds', sessionId, true);
  setSessionError(sessionId, '');
  try {
    const patch = await applyRemoteMode(session, options, modeId);
    updateSessionOptions(sessionId, patch);
    return true;
  } catch (error) {
    setSessionError(sessionId, error instanceof Error ? error.message : i18n.get('error.switchModeFailed'));
    return false;
  } finally {
    setSessionFlag('changingModeSessionIds', sessionId, false);
  }
};
