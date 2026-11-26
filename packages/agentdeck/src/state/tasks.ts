import { Toast } from '@mantou/tap-ui/elements/toast';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import type { PermissionRequest, TaskListItem, TaskSchedule, UserInput } from 'src/agent/api';
import { agentApi } from 'src/agent/transport';
import { i18n } from 'src/i18n';
import { getConfigSelects } from 'src/session/config-options';
import type { DeckSession } from 'src/session/types';
import { refreshSessions } from 'src/state/sessions';
import { agentdeckStore, getRuntime } from 'src/state/store';

/**
 * Scheduled tasks of the connected host, across all agents; the daemon runs them. Nobody has a turn in a run, and its
 * session can't be loaded while it runs, so the run's permission requests are kept here and answered from the task.
 */
export const tasksStore = createStore({
  tasks: [] as TaskListItem[],
  permissions: [] as PermissionRequest[],
  loaded: false,
});

const runningSessionIds = (tasks: TaskListItem[]) =>
  new Set(tasks.flatMap((task) => (task.runningSessionId ? [task.runningSessionId] : [])));

const runPermissions = (inputs: UserInput[], tasks: TaskListItem[]) => {
  const sessions = runningSessionIds(tasks);
  return inputs.flatMap(({ method, params }) =>
    method === 'agent_permission_request' && sessions.has(params.sessionId) ? [params] : [],
  );
};

/** Body of an `agentdeck-task` block, as taught by the host's task skill. */
export type TaskDraft = {
  name: string;
  prompt: string;
  schedule: TaskSchedule;
  timeoutMinutes?: number;
  retries?: number;
};

let tasksRequest = 0;

/** Older hosts have no tasks; any failure leaves the list as it was. */
export const refreshTasks = async () => {
  if (agentdeckStore.connection !== 'connected') return;
  const request = ++tasksRequest;
  try {
    const tasks = await agentApi.listTasks();
    const { userInputs = [] } = runningSessionIds(tasks).size ? await agentApi.listActiveSessions() : {};
    if (request === tasksRequest) tasksStore({ tasks, permissions: runPermissions(userInputs, tasks), loaded: true });
  } catch (error) {
    console.error('Failed to list tasks:', error);
  }
};

export const resetTasks = () => {
  tasksRequest++;
  tasksStore({ tasks: [], permissions: [], loaded: false });
};

// Run sessions are left out of the list, but a running one is opened from its task, and a push opens it.
agentApi.setTaskUpdatedHandler(() => {
  refreshTasks();
  refreshSessions();
});

export const getTask = (id: string) => tasksStore.tasks.find((task) => task.id === id);

/** The task whose running attempt is `sessionId`. */
export const getRunningTask = (sessionId: string) =>
  tasksStore.tasks.find((task) => task.runningSessionId === sessionId);

/** Takes a permission request of a task run; `false` for any other session. */
export const showTaskPermission = (request: PermissionRequest) => {
  if (!getRunningTask(request.sessionId)) return false;
  const { permissions } = tasksStore;
  if (!permissions.some((item) => item.requestId === request.requestId))
    tasksStore({ permissions: [...permissions, request] });
  return true;
};

/** Drops a task permission request resolved on any device or cancelled by the host. */
export const clearTaskPermission = (requestId: string) => {
  if (!tasksStore.permissions.some((item) => item.requestId === requestId)) return;
  tasksStore({ permissions: tasksStore.permissions.filter((item) => item.requestId !== requestId) });
};

export const getTaskPermission = (task: TaskListItem) =>
  tasksStore.permissions.find((request) => request.sessionId === task.runningSessionId);

/** The card closes at once; a failed answer (e.g. the host already rejected it) reloads what is still waiting. */
export const resolveTaskPermission = async (request: PermissionRequest, optionId: string | null) => {
  tasksStore({ permissions: tasksStore.permissions.filter((item) => item.requestId !== request.requestId) });
  try {
    await agentApi.respondUserInput(request, optionId ? { optionId } : {});
  } catch {
    Toast.open('error', i18n.get('userInput.failed'));
    refreshTasks();
  }
};

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Whether the task already has what the card proposes. */
export const isDraftSaved = (draft: TaskDraft) =>
  tasksStore.tasks.some(
    (task) =>
      task.name === draft.name &&
      task.prompt === draft.prompt &&
      JSON.stringify(task.schedule) === JSON.stringify(draft.schedule),
  );

/**
 * Saves a task card of `session`: a session has one task, which later cards there update. The task runs with the
 * session's agent, directory and config options.
 */
export const saveTaskFromSession = async (session: DeckSession, draft: TaskDraft) => {
  const existing = tasksStore.tasks.find((task) => task.originSessionId === session.sessionId);
  const configOptions = Object.fromEntries(
    getConfigSelects(getRuntime(session.sessionId).options)
      .filter((select) => !select.legacyMode)
      .map((select) => [select.id, select.currentValue]),
  );
  await agentApi.upsertTask({
    id: existing?.id,
    name: draft.name,
    agent: session.agent,
    cwd: session.cwd,
    prompt: draft.prompt,
    schedule: draft.schedule,
    configOptions,
    timeoutMinutes: draft.timeoutMinutes ?? existing?.timeoutMinutes ?? 60,
    retries: draft.retries ?? existing?.retries ?? 0,
    enabled: existing?.enabled ?? true,
    originSessionId: session.sessionId,
  });
  await refreshTasks();
  return existing ? 'updated' : 'created';
};

/** Runs the toast-reported task action, refreshing the list after it. */
export const runTaskAction = async (action: () => Promise<unknown>, success?: string) => {
  try {
    await action();
    if (success) Toast.open('success', success);
  } catch (error) {
    Toast.open('error', error instanceof Error ? error.message : i18n.get('task.actionFailed'));
  } finally {
    refreshTasks();
  }
};

const weekdayName = (day: number) =>
  // 2024-01-01 is a Monday.
  new Intl.DateTimeFormat(i18n.currentLanguage, { weekday: 'short' }).format(new Date(2024, 0, day));

/** Daily times are shown as set, named with their time zone when it isn't this device's (e.g. `每天 09:00 纽约时间`). */
export const formatSchedule = (schedule: TaskSchedule) => {
  if (schedule.type === 'interval') {
    const { minutes } = schedule;
    return getStringFromTemplate(
      minutes % 60 ? i18n.get('task.everyMinutes', String(minutes)) : i18n.get('task.everyHours', String(minutes / 60)),
    );
  }
  const days = [...new Set(schedule.weekdays ?? [])].sort();
  const daysText =
    !days.length || days.length === 7
      ? i18n.get('task.everyDay')
      : days.join() === '1,2,3,4,5'
        ? i18n.get('task.workdays')
        : days.map(weekdayName).join(' ');
  const { timeZone } = schedule;
  const zoneText =
    timeZone !== deviceTimeZone()
      ? new Intl.DateTimeFormat(i18n.currentLanguage, { timeZone, timeZoneName: 'shortGeneric' })
          .formatToParts()
          .find((part) => part.type === 'timeZoneName')?.value
      : undefined;
  return [daysText, ...schedule.times, zoneText].filter(Boolean).join(' ');
};

export const formatTaskTime = (time: string) =>
  new Intl.DateTimeFormat(i18n.currentLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
