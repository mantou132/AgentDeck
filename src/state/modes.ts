import { agentApi } from '../agent/transport';
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
    throw new Error('远端会话不支持所选模式，请重新选择后发送。');
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
  if (
    !options ||
    agentdeckStore.changingModeSessionIds.includes(sessionId) ||
    agentdeckStore.pendingSessionIds.includes(sessionId)
  )
    return false;
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
    setSessionError(sessionId, error instanceof Error ? error.message : '切换模式失败，请重试。');
    return false;
  } finally {
    setSessionFlag('changingModeSessionIds', sessionId, false);
  }
};
