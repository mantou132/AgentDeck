import { Toast } from '@mantou/tap-ui/elements/toast';
import type { ElicitationRequest, ElicitationResponse, PermissionRequest } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { hapticWarning } from '../lib/haptics';
import type { Elicitation } from '../session/elicitation';
import { getRuntime, isTurnRunning, updateRuntime } from './store';

// Requests waiting for the user (permissions and form elicitations) arrive as host notifications and are
// answered with `agent_user_input_respond`. The host keeps them until answered and lists them again after
// reconnecting, so repeats are ignored by `requestId`.

/** `undefined` drops the session's permission request. */
const setPermission = (sessionId: string, permission?: PermissionRequest) => updateRuntime(sessionId, { permission });

const setElicitations = (sessionId: string, elicitations: Elicitation[]) => updateRuntime(sessionId, { elicitations });

const setElicitationResponse = (request: ElicitationRequest, response?: ElicitationResponse) =>
  setElicitations(
    request.sessionId,
    (getRuntime(request.sessionId).elicitations ?? []).map((item) =>
      item.request.requestId === request.requestId ? { request: item.request, response } : item,
    ),
  );

export const showPermission = (request: PermissionRequest) => {
  if (!isTurnRunning(request.sessionId)) return;
  if (getRuntime(request.sessionId).permission?.requestId === request.requestId) return;
  setPermission(request.sessionId, request);
  hapticWarning();
};

/** `null` cancels the tool call. The card closes at once and comes back if the host does not take the answer. */
export const resolvePermission = async (sessionId: string, optionId: string | null) => {
  const request = getRuntime(sessionId).permission;
  if (!request) return;
  setPermission(sessionId);
  try {
    await agentApi.respondUserInput(request, optionId ? { optionId } : {});
  } catch {
    if (isTurnRunning(sessionId) && !getRuntime(sessionId).permission) setPermission(sessionId, request);
    Toast.open('error', i18n.get('userInput.failed'));
  }
};

export const showElicitation = (request: ElicitationRequest) => {
  if (!isTurnRunning(request.sessionId)) return;
  const current = getRuntime(request.sessionId).elicitations ?? [];
  if (current.some((item) => item.request.requestId === request.requestId)) return;
  setElicitations(request.sessionId, [...current, { request }]);
  hapticWarning();
};

/** The card turns read-only at once and becomes answerable again if the host does not take the answer. */
export const answerElicitation = async (request: ElicitationRequest, response: ElicitationResponse) => {
  setElicitationResponse(request, response);
  try {
    await agentApi.respondUserInput(request, response);
  } catch {
    setElicitationResponse(request);
    Toast.open('error', i18n.get('userInput.failed'));
  }
};

/** The turn stopped and the host has cancelled what was unanswered: the permission card closes, questions show cancelled. */
export const settleUserInput = (sessionId: string) => {
  const { permission, elicitations: current } = getRuntime(sessionId);
  if (permission) setPermission(sessionId);
  if (!current?.some((item) => !item.response)) return;
  setElicitations(
    sessionId,
    current.map((item) => (item.response ? item : { request: item.request, response: { action: 'cancel' } })),
  );
};
