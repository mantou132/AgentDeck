import { Toast } from '@mantou/tap-ui/elements/toast';
import type { ElicitationRequest, ElicitationResponse, PermissionRequest } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { hapticWarning } from '../lib/haptics';
import type { Elicitation } from '../session/elicitation';
import { agentdeckStore } from './store';

// Requests waiting for the user (permissions and form elicitations) arrive as host notifications and are
// answered with `agent_user_input_respond`. The host keeps them until answered and lists them again after
// reconnecting, so repeats are ignored by `requestId`.

const isTurnRunning = (sessionId: string) => agentdeckStore.pendingSessionIds.includes(sessionId);

/** `undefined` drops the session's permission request. */
const setPermission = (sessionId: string, request?: PermissionRequest) => {
  const next = { ...agentdeckStore.permissionsBySession };
  if (request) next[sessionId] = request;
  else delete next[sessionId];
  agentdeckStore({ permissionsBySession: next });
};

/** `undefined` drops the session's questions. */
const setElicitations = (sessionId: string, elicitations?: Elicitation[]) => {
  const next = { ...agentdeckStore.elicitationsBySession };
  if (elicitations) next[sessionId] = elicitations;
  else delete next[sessionId];
  agentdeckStore({ elicitationsBySession: next });
};

const setElicitationResponse = (request: ElicitationRequest, response?: ElicitationResponse) =>
  setElicitations(
    request.sessionId,
    agentdeckStore.elicitationsBySession[request.sessionId]?.map((item) =>
      item.request.requestId === request.requestId ? { request: item.request, response } : item,
    ),
  );

export const showPermission = (request: PermissionRequest) => {
  if (!isTurnRunning(request.sessionId)) return;
  if (agentdeckStore.permissionsBySession[request.sessionId]?.requestId === request.requestId) return;
  setPermission(request.sessionId, request);
  hapticWarning();
};

/** `null` cancels the tool call. The card closes at once and comes back if the host does not take the answer. */
export const resolvePermission = async (sessionId: string, optionId: string | null) => {
  const request = agentdeckStore.permissionsBySession[sessionId];
  if (!request) return;
  setPermission(sessionId);
  try {
    await agentApi.respondUserInput(request, optionId ? { optionId } : {});
  } catch {
    if (isTurnRunning(sessionId) && !agentdeckStore.permissionsBySession[sessionId]) setPermission(sessionId, request);
    Toast.open('error', i18n.get('userInput.failed'));
  }
};

export const showElicitation = (request: ElicitationRequest) => {
  if (!isTurnRunning(request.sessionId)) return;
  const current = agentdeckStore.elicitationsBySession[request.sessionId] ?? [];
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
  if (agentdeckStore.permissionsBySession[sessionId]) setPermission(sessionId);
  const current = agentdeckStore.elicitationsBySession[sessionId];
  if (!current?.some((item) => !item.response)) return;
  setElicitations(
    sessionId,
    current.map((item) => (item.response ? item : { request: item.request, response: { action: 'cancel' } })),
  );
};

export const removeElicitations = (sessionId: string) => setElicitations(sessionId);
