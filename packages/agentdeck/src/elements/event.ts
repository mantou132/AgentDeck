import { Toast } from '@mantou/tap-ui/elements/toast';
import { addEvent, type CalendarEvent, type Recurrence } from 'tauri-plugin-add-to-calendar-api';
import { EVENTS_ADDED_KEY } from '../config';
import { i18n, type LocaleKey } from '../i18n';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
/** Sources of the most recently added events, enough to cover what is still on screen. */
const MAX_ADDED = 200;

/** A date alone (`2026-12-01`) is local midnight, unlike `Date.parse` which reads it as UTC. */
const parseTime = (value: unknown, endOfDay = false) => {
  if (typeof value !== 'string') return;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const time = date
    ? new Date(+date[1], +date[2] - 1, +date[3], ...(endOfDay ? [23, 59, 59] : [])).getTime()
    : Date.parse(value);
  if (!Number.isNaN(time)) return time;
};

/** Body of an `agentdeck-event` fenced block, as taught by the host's event skill. */
const parseEvent = (source: string): CalendarEvent | undefined => {
  try {
    const { title, start, end, allDay, location, notes, recurrence } = JSON.parse(source);
    const startTime = parseTime(start);
    if (typeof title !== 'string' || !title.trim() || startTime === undefined) return;
    const event: CalendarEvent = { title, start: startTime, allDay: allDay === true };
    const endTime = parseTime(end);
    if (endTime !== undefined && endTime >= startTime) event.end = endTime;
    if (typeof location === 'string' && location.trim()) event.location = location;
    if (typeof notes === 'string' && notes.trim()) event.notes = notes;
    if (FREQUENCIES.includes(recurrence?.frequency)) {
      const { frequency, interval, count, until } = recurrence;
      const rule: Recurrence = { frequency };
      if (Number.isInteger(interval) && interval > 1) rule.interval = interval;
      if (Number.isInteger(count) && count > 0) rule.count = count;
      else rule.until = parseTime(until, true);
      event.recurrence = rule;
    }
    return event;
  } catch {}
};

const loadAdded = () => {
  try {
    const value = JSON.parse(localStorage.getItem(EVENTS_ADDED_KEY) || '[]');
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  } catch {}
  return [];
};

/** Events the user added, by block source; the calendar itself can't be read to tell. */
const addedStore = createStore({ sources: new Set(loadAdded()) });

const markEventAdded = (source: string) => {
  const sources = [...addedStore.sources]
    .filter((item) => item !== source)
    .concat(source)
    .slice(-MAX_ADDED);
  addedStore({ sources: new Set(sources) });
  try {
    localStorage.setItem(EVENTS_ADDED_KEY, JSON.stringify(sources));
  } catch {}
};

const formatTime = ({ start, end, allDay }: CalendarEvent) => {
  const format = new Intl.DateTimeFormat(
    i18n.currentLanguage,
    allDay ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' },
  );
  return end === undefined ? format.format(start) : format.formatRange(start, end);
};

const formatRecurrence = ({ frequency, interval, count, until }: Recurrence) => {
  const repeat = interval
    ? i18n.get(`event.${frequency}N` as LocaleKey, String(interval))
    : i18n.get(`event.${frequency}` as LocaleKey);
  if (count) return `${repeat} · ${i18n.get('event.times', String(count))}`;
  if (until !== undefined) {
    const date = new Intl.DateTimeFormat(i18n.currentLanguage, { dateStyle: 'medium' }).format(until);
    return `${repeat} · ${i18n.get('event.until', date)}`;
  }
  return repeat;
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
  .card:active {
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
  .detail {
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    line-height: 1.5;
  }
  .action {
    flex-shrink: 0;
    align-self: center;
    color: ${agentDeckTheme.primaryStrongColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
  }
  .action.added {
    color: ${agentDeckTheme.describeColor};
  }
  pre {
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
`;

/** An event the agent offers; tapping it opens the system calendar editor prefilled with it. */
@customElement('deck-event')
@adoptedStyle(style)
@connectStore(addedStore)
@shadow()
export class DeckEventElement extends GemElement {
  @attribute source: string;

  @memo((i) => [i.source])
  get #event() {
    return parseEvent(this.source);
  }

  #add = async (event: CalendarEvent) => {
    try {
      // iOS reports whether the user saved; Android calendar apps don't, so opening the editor counts.
      const { saved } = await addEvent(event);
      if (saved !== false) markEventAdded(this.source);
    } catch (error) {
      console.error(error);
      Toast.open('error', i18n.get('event.failed'));
    }
  };

  @template()
  #render = () => {
    const event = this.#event;
    // Invalid JSON stays readable as the original block.
    if (!event) return html`<pre>${this.source}</pre>`;
    const added = addedStore.sources.has(this.source);
    // Adding again stays possible: the user may have deleted it or want another copy.
    return html`
      <button class="card" type="button" @click=${() => this.#add(event)}>
        <tap-use .element=${icons.date}></tap-use>
        <div class="text">
          <div class="title">${event.title}</div>
          <div class="detail">${formatTime(event)}</div>
          <div class="detail" v-if=${!!event.recurrence}>${event.recurrence && formatRecurrence(event.recurrence)}</div>
          <div class="detail" v-if=${!!event.location}>${event.location}</div>
        </div>
        <span class=${classMap({ action: true, added })}>${i18n.get(added ? 'event.added' : 'event.add')}</span>
      </button>
    `;
  };
}
