import { ActionSheet } from '@mantou/tap-ui/elements/action-sheet';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import type { TaskListItem, TaskRun } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { openSession } from '../navigation';
import { getSession } from '../state/sessions';
import { agentdeckStore, hostAgents, hostHome, updateRuntime } from '../state/store';
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
  deck-foldable {
    margin: 0;
  }
`;

/** Opens a session of `agent` without switching the App's global agent setting. */
const openAgentSession = (agent: string, sessionId: string, cwd = '') => {
  const existing = getSession(sessionId);
  if (!existing) {
    updateRuntime(sessionId, { session: { sessionId, agent, cwd } });
  } else if (!existing.agent || !existing.cwd) {
    updateRuntime(sessionId, { session: { ...existing, agent: existing.agent || agent, cwd: existing.cwd || cwd } });
  }
  openSession(sessionId);
};

const runStatusBadge: Record<TaskRun['status'], string> = {
  success: 'bg-positive/10 text-positive',
  failed: 'bg-negative/10 text-negative',
  timeout: 'bg-notice/10 text-notice',
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
        if (task.originSessionId) openAgentSession(task.agent, task.originSessionId, task.cwd);
        return;
      case 'toggle':
        return runTaskAction(() => agentApi.setTaskEnabled(task.id, !task.enabled));
      case 'delete':
        await runTaskAction(() => agentApi.deleteTask(task.id), i18n.get('task.deleted'));
        if (!getTask(task.id)) Stack.instance?.pop();
    }
  };

  #renderRun = (run: TaskRun, agent: string, cwd: string) => {
    const { sessionId } = run;
    return html`
      <button
        type="button"
        class="flex w-full items-start gap-3 border-0 border-b border-solid border-border/70 bg-bg-light p-4 text-left last:border-b-0 enabled:cursor-pointer enabled:active:bg-bg-hover disabled:cursor-default"
        ?disabled=${!sessionId}
        @click=${() => sessionId && openAgentSession(agent, sessionId, cwd)}
      >
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-2">
            <span
              class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${runStatusBadge[run.status]}"
            >
              <span class="size-1.5 rounded-full bg-current"></span>
              ${i18n.get(`task.${run.status}`)}
            </span>
            <span class="text-xs text-describe">${formatTaskTime(run.startedAt)} · ${duration(run)}</span>
          </span>
          <span v-if=${!!run.summary} class="mt-2 line-clamp-3 block text-sm leading-relaxed text-text">
            ${run.summary}
          </span>
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
      <div class="mx-auto flex w-full max-w-[560px] flex-col gap-4 p-4">
        <deck-permission-request
          v-if=${!!permission}
          .request=${permission}
          @resolve=${({ detail }: CustomEvent<string | null>) => permission && resolveTaskPermission(permission, detail)}
        ></deck-permission-request>

        <section class="overflow-hidden rounded-[20px] border border-border bg-bg-light shadow-card">
          <header class="flex items-center justify-between gap-3 p-4">
            <div class="flex min-w-0 items-center gap-3">
              <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong">
                <tap-use class="size-5" .element=${icons.schedule}></tap-use>
              </span>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-base font-semibold text-highlight">${formatSchedule(task.schedule)}</span>
                  ${renderTaskStatus(task)}
                </div>
                <div v-if=${!!task.nextRunAt} class="mt-0.5 truncate text-xs text-describe">
                  ${i18n.get('task.nextRun')} ${task.nextRunAt ? formatTaskTime(task.nextRunAt) : ''}
                </div>
              </div>
            </div>
          </header>

          <div
            class="flex items-center gap-2 border-t border-border/70 bg-bg/50 px-4 py-2 font-mono text-xs text-describe"
            title=${task.cwd}
          >
            <span class="truncate font-semibold text-text">${agentName}</span>
            <span class="text-disabled">·</span>
            <span class="truncate">${displayPath(task.cwd, hostHome())}</span>
          </div>

          <div class="border-t border-border/70 p-4">
            <div class="mb-2 text-xs font-semibold text-describe uppercase tracking-wide">
              ${i18n.get('task.prompt')}
            </div>
            <deck-foldable
              size="small"
              cwd=${task.cwd}
              label=${task.name}
              .markdown=${task.prompt}
            >
              <deck-stream-markdown
                class="select-text text-sm leading-relaxed"
                .text=${task.prompt}
                cwd=${task.cwd}
              ></deck-stream-markdown>
            </deck-foldable>
          </div>
        </section>

        <section class="overflow-hidden rounded-[20px] border border-border bg-bg-light shadow-card">
          <header class="flex min-w-0 items-center justify-between border-b border-border/70 px-4 py-3">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-highlight">${i18n.get('task.runs')}</span>
              <span v-if=${runs.length > 0} class="rounded-lg bg-bg px-2 py-0.5 font-mono text-xs font-bold text-describe">
                ${runs.length}
              </span>
            </div>
          </header>
          <deck-error
            v-if=${!!error}
            heading=${i18n.get('task.runsFailed')}
            error=${error}
            @retry=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></deck-error>
          <div v-else-if=${entered && !runs.length && !task.running} class="p-6 text-center text-sm text-describe">
            ${i18n.get('task.noRuns')}
          </div>
          <div v-else-if=${entered}>
            ${runs.map((run) => this.#renderRun(run, task.agent, task.cwd))}
          </div>
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
