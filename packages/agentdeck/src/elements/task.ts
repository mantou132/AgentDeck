import type { Emitter } from '@mantou/gem/lib/decorators';
import type { TaskSchedule } from '../agent/api';
import { i18n } from '../i18n';
import { deviceTimeZone, formatSchedule, isDraftSaved, type TaskDraft, tasksStore } from '../state/tasks';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

const isTime = (value: unknown) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const isTimeZone = (value: unknown) => {
  try {
    return typeof value === 'string' && !!new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    return false;
  }
};

/** A daily schedule without a time zone is in the user's, this device's. */
const parseSchedule = (value: unknown): TaskSchedule | undefined => {
  const schedule = value as Partial<Record<string, unknown>> | undefined;
  if (schedule?.type === 'interval' && Number.isInteger(schedule.minutes) && (schedule.minutes as number) >= 5)
    return { type: 'interval', minutes: schedule.minutes as number };
  if (schedule?.type !== 'daily' || !Array.isArray(schedule.times) || !schedule.times.length) return;
  if (!schedule.times.every(isTime)) return;
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
  if (!weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) return;
  const timeZone = schedule.timeZone ?? deviceTimeZone();
  if (!isTimeZone(timeZone)) return;
  return { type: 'daily', times: schedule.times, weekdays, timeZone: timeZone as string };
};

const positive = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined);

/** Body of an `agentdeck-task` fenced block, as taught by the host's task skill. */
const parseDraft = (source: string): TaskDraft | undefined => {
  try {
    const { name, prompt, schedule, timeoutMinutes, retries } = JSON.parse(source);
    const parsed = parseSchedule(schedule);
    if (typeof name !== 'string' || !name.trim() || typeof prompt !== 'string' || !prompt.trim() || !parsed) return;
    return {
      name: name.trim(),
      prompt,
      schedule: parsed,
      timeoutMinutes: positive(timeoutMinutes),
      retries: Number.isInteger(retries) && retries >= 0 ? retries : undefined,
    };
  } catch {}
};

const style = css`
  :host {
    display: block;
    box-sizing: border-box;
    overflow: hidden;
  }
  .card {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .card:disabled {
    cursor: default;
  }
  .card:disabled .save {
    color: ${agentDeckTheme.describeColor};
  }
  .card:not(:disabled):active {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
  tap-use {
    flex-shrink: 0;
    width: 1.5rem;
    color: ${agentDeckTheme.primaryColor};
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title {
    color: ${agentDeckTheme.highlightColor};
    font-weight: 600;
  }
  .schedule {
    color: ${agentDeckTheme.primaryStrongColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
  }
  .prompt {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .note {
    margin-top: 0.375rem;
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    line-height: 1.4;
    opacity: 0.8;
  }
  .save {
    flex-shrink: 0;
    align-self: center;
    color: ${agentDeckTheme.primaryStrongColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
  }
  pre {
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
`;

/** A scheduled task the agent proposes; tapping it saves the task, which runs with this session's agent and directory. */
@customElement('deck-task')
@adoptedStyle(style)
@connectStore(tasksStore)
@shadow()
export class DeckTaskElement extends GemElement {
  @attribute source: string;
  /** Draft for the session page to save as this session's task. */
  @globalemitter saveTask: Emitter<TaskDraft>;

  @memo((i) => [i.source])
  get #draft() {
    return parseDraft(this.source);
  }

  @template()
  #render = () => {
    const draft = this.#draft;
    // Invalid JSON stays readable as the original block.
    if (!draft) return html`<pre>${this.source}</pre>`;
    const saved = isDraftSaved(draft);
    return html`
      <button class="card" type="button" ?disabled=${saved} @click=${() => this.saveTask(draft)}>
        <tap-use .element=${icons.schedule}></tap-use>
        <div class="text">
          <div class="title">${draft.name}</div>
          <div class="schedule">${formatSchedule(draft.schedule)}</div>
          <div class="prompt">${draft.prompt}</div>
          <div class="note">${i18n.get('task.approvalNote')}</div>
        </div>
        <span class="save">${i18n.get(saved ? 'task.saved' : 'task.save')}</span>
      </button>
    `;
  };
}
