import type { PermissionRequest, SessionEvent } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import type { Attachment, DeckSession } from './types';

const permissionResolvers = new Map<string, { resolve: (optionId: string) => void; reject: (error: Error) => void }>();

export const requestPermission = (request: PermissionRequest, onNotify: (request: PermissionRequest) => void) => {
  if (!request?.sessionId) return Promise.reject(new Error(i18n.get('error.permissionMissingSessionId')));
  permissionResolvers.get(request.sessionId)?.reject(new Error(i18n.get('error.permissionReplaced')));
  onNotify(request);
  return new Promise<string>((resolve, reject) => permissionResolvers.set(request.sessionId, { resolve, reject }));
};

export const resolvePermission = (sessionId: string, optionId: string | null, onClean: (sessionId: string) => void) => {
  const resolver = permissionResolvers.get(sessionId);
  permissionResolvers.delete(sessionId);
  onClean(sessionId);
  if (!resolver) return;
  if (optionId) resolver.resolve(optionId);
  else resolver.reject(new Error(i18n.get('error.permissionUserCancelled')));
};

export const declineAllPermissions = (onClean: (sessionId: string) => void) => {
  for (const sessionId of permissionResolvers.keys()) {
    resolvePermission(sessionId, null, onClean);
  }
};

let draftCanceled = false;

export const setDraftCanceled = (canceled: boolean) => {
  draftCanceled = canceled;
};

export const isDraftCanceled = () => draftCanceled;

export const performTurn = async (
  session: DeckSession,
  text: string,
  handlers: {
    onEvent: (event: SessionEvent) => void;
    onAnswer: (answer: string) => void;
    onError: (error: string) => void;
    onDone: (completed: boolean) => void;
  },
  attachments: Attachment[] = [],
) => {
  let completed = false;
  let cancelled = false;
  try {
    const result = await agentApi.prompt(
      session.sessionId,
      session.agent,
      text,
      (event) => {
        if (event.event === 'stop') cancelled = event.stop_reason === 'cancelled';
        handlers.onEvent(event);
      },
      attachments.map((attachment) => {
        if (attachment.kind === 'image') {
          return { type: 'image', data: attachment.data, mimeType: attachment.mimeType };
        }
        const name = attachment.name.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        return { type: 'text', text: `<attachment name="${name}">\n${attachment.text}\n</attachment>` };
      }),
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
