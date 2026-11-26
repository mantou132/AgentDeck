import { Toast } from '@mantou/tap-ui/elements/toast';
import type { ElicitationRequest, ElicitationResponse, PermissionRequest, UserInput } from 'src/agent/api';
import { agentApi } from 'src/agent/transport';
import { i18n } from 'src/i18n';
import { hapticWarning } from 'src/lib/haptics';
import type { Elicitation } from 'src/session/elicitation';
import { getRuntime, isTurnRunning, updateRuntime } from 'src/state/store';

// Requests waiting for the user (permissions and form elicitations) arrive as broadcast host notifications,
// are included in `openSession` / `listActiveSessions` snapshots, and are cleared via `agent_user_input_resolved`
// when answered on any device or cancelled by the host.

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

/** Drops a pending request that was answered on another device or cancelled by the host. */
export const clearUserInput = (sessionId: string, requestId: string) => {
  const { permission, elicitations } = getRuntime(sessionId);
  if (permission?.requestId === requestId) setPermission(sessionId);
  if (elicitations?.some((item) => !item.response && item.request.requestId === requestId)) {
    setElicitations(
      sessionId,
      elicitations.filter((item) => item.response || item.request.requestId !== requestId),
    );
  }
};

/** Reconciles a session's pending user inputs with an authoritative snapshot from `openSession`. */
export const replaceSessionUserInputs = (sessionId: string, inputs: UserInput[]) => {
  const permission = inputs.find((item) => item.method === 'agent_permission_request')?.params as
    | PermissionRequest
    | undefined;
  const pendingElicitations = inputs
    .filter((item) => item.method === 'agent_elicitation_request')
    .map((item) => item.params as ElicitationRequest);
  const current = getRuntime(sessionId).elicitations ?? [];
  const answered = current.filter((item) => Boolean(item.response));
  const nextElicitations: Elicitation[] = [
    ...answered,
    ...pendingElicitations
      .filter((request) => !answered.some((item) => item.request.requestId === request.requestId))
      .map((request) => ({ request })),
  ];
  updateRuntime(sessionId, { permission, elicitations: nextElicitations.length ? nextElicitations : undefined });
};

/**
 * The host has cancelled what was unanswered: the permission card closes, questions show cancelled.
 * That is everything when the turn stopped, and only its requests when subagent `childSessionId` was cancelled.
 */
export const settleUserInput = (sessionId: string, childSessionId?: string) => {
  const settled = (request: PermissionRequest | ElicitationRequest) =>
    !childSessionId || request.childSessionId === childSessionId;
  const { permission, elicitations: current } = getRuntime(sessionId);
  if (permission && settled(permission)) setPermission(sessionId);
  if (!current?.some((item) => !item.response && settled(item.request))) return;
  setElicitations(
    sessionId,
    current.map((item) =>
      item.response || !settled(item.request) ? item : { request: item.request, response: { action: 'cancel' } },
    ),
  );
};
