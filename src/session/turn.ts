import type { PermissionRequest, SessionEvent } from '../agent/api';
import { agentApi } from '../agent/transport';
import type { Attachment, DeckSession } from './types';

const permissionResolvers = new Map<string, { resolve: (optionId: string) => void; reject: (error: Error) => void }>();

export const requestPermission = (request: PermissionRequest, onNotify: (request: PermissionRequest) => void) => {
  if (!request?.sessionId) return Promise.reject(new Error('权限请求缺少 sessionId'));
  permissionResolvers.get(request.sessionId)?.reject(new Error('权限请求已被新请求替换'));
  onNotify(request);
  return new Promise<string>((resolve, reject) => permissionResolvers.set(request.sessionId, { resolve, reject }));
};

export const resolvePermission = (sessionId: string, optionId: string | null, onClean: (sessionId: string) => void) => {
  const resolver = permissionResolvers.get(sessionId);
  permissionResolvers.delete(sessionId);
  onClean(sessionId);
  if (!resolver) return;
  if (optionId) resolver.resolve(optionId);
  else resolver.reject(new Error('用户取消了权限请求'));
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
    onDone: () => void;
  },
  attachments: Attachment[] = [],
) => {
  try {
    const result = await agentApi.prompt(
      session.sessionId,
      session.agent,
      text,
      handlers.onEvent,
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
  } catch (error) {
    handlers.onError(error instanceof Error ? error.message : '发送消息失败');
  } finally {
    handlers.onDone();
  }
};

export const cancelTurnPrompt = async (session: DeckSession) => {
  const result = await agentApi.cancelPrompt(session.sessionId, session.agent);
  if (result.cancelled === false) {
    throw new Error('远端已无法停止这个任务，请在设置中重置 App 后重新加载会话。');
  }
};
