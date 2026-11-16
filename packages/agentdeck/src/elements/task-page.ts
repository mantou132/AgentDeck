import { ActionSheet } from '@mantou/tap-ui/elements/action-sheet';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import type { TaskListItem, TaskRun } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { selectSession } from '../navigation';
import { saveSettings } from '../state/app';
import { getSession, refreshSessions } from '../state/sessions';
import { agentdeckStore, hostAgents, hostHome } from '../state/store';
import {
  formatSchedule,
  formatTaskTime,
  getTask,
  getTaskPermission,
  resolveTaskPermission,
  runTaskAction,
  tasksStore,
} from '../state/tasks';
import { icons } from '../styles/icons';
import { renderTaskStatus } from './task-group';

const pageStyle = css`
  :scope {
    height: 100%;
  }
  footer {
    height: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  }
`;

/** Opens a session of `agent`, switching the App to that agent first as pushes do. */
const openAgentSession = (agent: string, sessionId: string) => {
  const { settings } = agentdeckStore;
  if (agent !== settings.agent) saveSettings({ ...settings, agent });
  else if (!getSession(sessionId)) refreshSessions();
  selectSession(sessionId);
};

const statusClass: Record<TaskRun['status'], string> = {
  success: 'text-positive',
  failed: 'text-negative',
  timeout: 'text-notice',
};

const duration = ({ startedAt, endedAt }: TaskRun) =>
  getStringFromTemplate(
    i18n.get('task.minutes', String(Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000)))),
  );

/** A scheduled task: a waiting permission request of its run, what it does, its runs and the actions. */
@customElement('deck-task-page')
@adoptedStyle(blockContainer)
@adoptedStyle(pageStyle)
@connectStore(tasksStore)
@connectStore(agentdeckStore)
export class DeckTaskPageElement extends GemElement {
  @property taskId = '';

  #state = createState({ runs: [] as TaskRun[], error: '', entered: false, revision: 0 });

  /** Reloaded when a run starts or ends. */
  @effect((i) => [i.taskId, i.#state.revision, getTask(i.taskId)?.running, getTask(i.taskId)?.lastRun?.endedAt])
  #loadRuns = () => {
    if (!getTask(this.taskId)) return;
    let active = true;
    agentApi.taskRuns(this.taskId).then(
      (runs) => active && this.#state({ runs: runs.toReversed(), error: '' }),
      (error) => active && this.#state({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      active = false;
    };
  };

  #openActions = async () => {
    const task = getTask(this.taskId);
    if (!task) return;
    const action = await ActionSheet.open({
      title: task.name,
      actions: [
        { label: i18n.get('task.runNow'), value: 'run', disabled: task.running },
        ...(task.originSessionId ? [{ label: i18n.get('task.change'), value: 'change' }] : []),
        { label: i18n.get(task.enabled ? 'task.pause' : 'task.resume'), value: 'toggle' },
        { label: i18n.get('task.delete'), value: 'delete', danger: true },
      ],
      cancelText: i18n.get('global.cancel'),
    });
    switch (action?.value) {
      case 'run':
        return runTaskAction(() => agentApi.runTaskNow(task.id), i18n.get('task.started'));
      case 'change':
        if (task.originSessionId) openAgentSession(task.agent, task.originSessionId);
        return;
      case 'toggle':
        return runTaskAction(() => agentApi.setTaskEnabled(task.id, !task.enabled));
      case 'delete':
        await runTaskAction(() => agentApi.deleteTask(task.id), i18n.get('task.deleted'));
        if (!getTask(task.id)) Stack.instance?.pop();
    }
  };

  #renderRun = (run: TaskRun, agent: string) => {
    const { sessionId } = run;
    return html`
      <button
        type="button"
        class="flex w-full items-start gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left enabled:cursor-pointer enabled:active:bg-bg-hover"
        ?disabled=${!sessionId}
        @click=${() => sessionId && openAgentSession(agent, sessionId)}
      >
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2 text-xs">
            <span class="font-semibold ${statusClass[run.status]}">${i18n.get(`task.${run.status}`)}</span>
            <span class="text-describe">${formatTaskTime(run.startedAt)} · ${duration(run)}</span>
          </span>
          <span class="mt-1 line-clamp-3 block text-sm text-text">${run.summary}</span>
        </span>
        <tap-use v-if=${!!sessionId} class="mt-1 size-3.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>
      </button>
    `;
  };

  #renderTask = (task: TaskListItem) => {
    const { runs, error, entered } = this.#state;
    const permission = getTaskPermission(task);
    const agentName = hostAgents().find((agent) => agent.id === task.agent)?.name || task.agent;
    return html`
      <div class="flex flex-col gap-4 p-4">
        <deck-permission-request
          v-if=${!!permission}
          .request=${permission}
          @resolve=${({ detail }: CustomEvent<string | null>) => permission && resolveTaskPermission(permission, detail)}
        ></deck-permission-request>

        <section class="rounded-2xl border border-border bg-bg-light px-4 py-3">
          <div class="flex min-w-0 items-center gap-2">
            <tap-use class="size-4 shrink-0 text-primary" .element=${icons.schedule}></tap-use>
            <span class="truncate text-sm font-semibold text-highlight">${formatSchedule(task.schedule)}</span>
            ${renderTaskStatus(task)}
          </div>
          <div v-if=${!!task.nextRunAt} class="mt-1 text-xs text-describe">
            ${i18n.get('task.nextRun')} ${task.nextRunAt && formatTaskTime(task.nextRunAt)}
          </div>
          <div class="mt-1 truncate font-mono text-xs text-describe" title=${task.cwd}>
            ${agentName} · ${displayPath(task.cwd, hostHome())}
          </div>
          <p class="select-text mt-3 mb-0 whitespace-pre-wrap text-sm leading-relaxed text-text">${task.prompt}</p>
        </section>

        <section>
          <h2 class="m-0 px-3 pb-1 text-xs font-semibold text-describe">${i18n.get('task.runs')}</h2>
          <deck-error
            v-if=${!!error}
            heading=${i18n.get('task.runsFailed')}
            error=${error}
            @retry=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></deck-error>
          <p v-else-if=${entered && !runs.length && !task.running} class="m-0 px-3 py-2 text-sm text-describe">
            ${i18n.get('task.noRuns')}
          </p>
          <div v-else-if=${entered}>${runs.map((run) => this.#renderRun(run, task.agent))}</div>
        </section>
      </div>
    `;
  };

  @template()
  #render = () => {
    const task = getTask(this.taskId);
    return html`
      <tap-page class="bg-bg text-text" .trackVisibility=${false} @full-show=${() => this.#state({ entered: true })}>
        <tap-navbar slot="header" title=${task?.name || i18n.get('task.title')} back default-back>
          <tap-use
            v-if=${!!task}
            slot="right"
            role="button"
            aria-label=${i18n.get('task.actions')}
            .element=${icons.more}
            @click=${this.#openActions}
          ></tap-use>
        </tap-navbar>
        <main class="min-h-full">
          ${
            task
              ? this.#renderTask(task)
              : tasksStore.loaded
                ? html`<div class="px-5 py-16 text-center text-sm text-describe">${i18n.get('task.notFound')}</div>`
                : html`<deck-loading label=${i18n.get('task.loading')}></deck-loading>`
          }
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
