import type { SessionEvent } from '../agent/api';
import { agentApi } from '../agent/transport';
import { toPromptAttachment } from '../attachment/prompt';
import { i18n } from '../i18n';
import type { DeckSession, TextMessage } from './types';

type TurnHandlers = {
  onEvent: (event: SessionEvent) => void | Promise<void>;
  onAnswer: (answer: string) => void;
  onError: (error: string) => void;
  onDone: (completed: boolean) => void;
};

let pendingSessionCanceled = false;

export const setPendingSessionCanceled = (canceled: boolean) => {
  pendingSessionCanceled = canceled;
};

export const isPendingSessionCanceled = () => pendingSessionCanceled;

export const performTurn = async (
  session: DeckSession,
  { text, attachments = [], voiceChat }: Pick<TextMessage, 'text' | 'attachments' | 'voiceChat'>,
  handlers: TurnHandlers,
  callId?: string,
) => {
  let completed = false;
  let cancelled = false;
  try {
    const result = await agentApi.prompt(
      session.sessionId,
      session.agent,
      text,
      async (event) => {
        if (event.event === 'stop') cancelled = event.stop_reason === 'cancelled';
        await handlers.onEvent(event);
      },
      attachments.map(toPromptAttachment),
      callId,
      voiceChat,
    );
    if (result.answer) {
      handlers.onAnswer(result.answer);
    }
    completed = !cancelled;
  } catch (error) {
    handlers.onError(error instanceof Error ? error.message : i18n.get('error.sendMessageFailed'));
  } finally {
    handlers.onDone(completed);
  }
};

export const cancelTurnPrompt = async (session: DeckSession) => {
  const result = await agentApi.cancelPrompt(session.sessionId, session.agent);
  if (result.cancelled === false) {
    throw new Error(i18n.get('error.cannotStopTask'));
  }
};
