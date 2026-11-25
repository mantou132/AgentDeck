import { repeat } from '@mantou/gem/lib/element';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { TaskListItem } from 'src/agent/api';
import { i18n } from 'src/i18n';
import { openTask } from 'src/navigation';
import { formatSchedule, formatTaskTime, getTaskPermission, tasksStore } from 'src/state/tasks';
import { icons } from 'src/styles/icons';

const badge = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold';

/** What the task needs from the user first: a waiting request, then a failed last run. */
export const renderTaskStatus = (task: TaskListItem) => {
  if (getTaskPermission(task))
    return html`<span class="${badge} bg-notice/10 text-notice">
      <span class="size-1.5 animate-pulse rounded-full bg-notice"></span>${i18n.get('session.permission')}
    </span>`;
  if (task.running)
    return html`<span class="${badge} bg-informative/10 text-informative">
      <span class="size-1.5 animate-pulse rounded-full bg-informative"></span>${i18n.get('session.running')}
    </span>`;
  if (!task.enabled) return html`<span class="${badge} bg-bg text-describe">${i18n.get('task.paused')}</span>`;
  const status = task.lastRun?.status;
  if (status === 'failed' || status === 'timeout')
    return html`<span class="${badge} bg-negative/10 text-negative">${i18n.get(`task.${status}`)}</span>`;
  return html``;
};

/** The host's scheduled tasks, above the session groups. */
@customElement('deck-task-group')
@adoptedStyle(blockContainer)
@connectStore(tasksStore)
export class DeckTaskGroupElement extends GemElement {
  @template()
  #render = () => {
    const { tasks } = tasksStore;
    return html`
      <section class="overflow-hidden rounded-[20px] border border-border bg-bg-light shadow-card">
        <header class="flex min-w-0 items-center gap-2.5 border-b border-border bg-bg-light/80 px-4 py-3">
          <span class="grid size-7 shrink-0 place-items-center rounded-[9px] bg-primary-soft text-primary-strong">
            <tap-use class="size-4" .element=${icons.schedule}></tap-use>
          </span>
          <span class="min-w-0 flex-1 truncate font-mono text-sm font-medium text-highlight">${i18n.get('task.group')}</span>
          <span class="rounded-lg bg-bg px-2 py-1 font-mono text-xs font-bold text-describe">${tasks.length}</span>
        </header>
        ${repeat(
          tasks,
          (task) => task.id,
          (task) => html`
            <button
              type="button"
              class="grid min-h-[72px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-0 border-b border-solid border-border/70 bg-bg-light px-4 py-3 text-left text-text last:border-b-0 active:bg-bg-hover"
              @click=${() => openTask(task.id)}
            >
              <span class="min-w-0">
                <span class="flex min-w-0 items-center gap-2 text-xs text-describe">
                  ${renderTaskStatus(task)}
                  <span class="truncate">
                    ${[formatSchedule(task.schedule), task.nextRunAt ? formatTaskTime(task.nextRunAt) : ''].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span class="mt-1.5 block truncate text-base leading-snug font-semibold text-highlight">
                  ${task.name}
                </span>
              </span>
              <tap-use class="size-[15px] shrink-0 text-describe" .element=${icons.right}></tap-use>
            </button>
          `,
        )}
      </section>
    `;
  };
}
