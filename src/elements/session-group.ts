import type { Emitter } from '@mantou/gem/lib/decorators';
import { repeat } from '@mantou/gem/lib/element';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { Time } from '@mantou/tap-ui/lib/time';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import type { DeckSession } from '../session/types';
import { icons } from '../styles/icons';

@customElement('deck-session-group')
@adoptedStyle(blockContainer)
export class DeckSessionGroupElement extends GemElement {
  @property cwd = '';
  @property sessions: DeckSession[] = [];
  @property unreadSessionIds: string[] = [];
  @property pendingSessionIds: string[] = [];
  @property permissionSessionIds: string[] = [];
  @property deletingSessionIds: string[] = [];
  @boolattribute deletionDisabled: boolean;
  @emitter select: Emitter<string>;
  @emitter requestDelete: Emitter<string>;

  #state = createState({ expanded: false });

  #toggleExpand = () => {
    this.#state({ expanded: !this.#state.expanded });
  };

  @template()
  #render = () => {
    const { expanded } = this.#state;
    const { cwd, sessions } = this;
    const visibleSessions = expanded ? sessions : sessions.slice(0, 5);

    return html`
      <section class="overflow-hidden rounded-[20px] border border-border bg-bg-light shadow-card">
        <header class="flex min-w-0 items-center gap-2.5 border-b border-border bg-bg-light/80 px-4 py-3">
          <span class="grid size-7 shrink-0 place-items-center rounded-[9px] bg-primary-soft text-primary-strong">
            <tap-use class="size-4" .element=${icons.folder}></tap-use>
          </span>
          <span class="min-w-0 flex-1 truncate font-mono text-sm font-medium text-highlight" title=${cwd}>
            ${displayPath(cwd)}
          </span>
          <span class="rounded-lg bg-bg px-2 py-1 font-mono text-xs font-bold text-describe">${sessions.length}</span>
        </header>
        <div>
          ${repeat(
            visibleSessions,
            (session) => session.sessionId,
            (session) => html`
              <tap-swipeout
                class="group border-0 border-b border-solid border-border/70 last:border-b-0"
                ?disabled=${this.deletionDisabled || this.deletingSessionIds.includes(session.sessionId)}
                @click=${(event: MouseEvent) => {
                  if (!event.defaultPrevented && !this.deletingSessionIds.includes(session.sessionId)) {
                    this.select(session.sessionId);
                  }
                }}
              >
                <button
                  type="button"
                  class="grid min-h-[72px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-0 bg-bg-light px-4 py-3 text-left text-text transition-colors duration-150 group-[:state(opened)]:bg-bg-hover hover:bg-bg-hover active:bg-bg-hover disabled:cursor-default disabled:opacity-50"
                  ?disabled=${this.deletingSessionIds.includes(session.sessionId)}
                  aria-busy=${this.deletingSessionIds.includes(session.sessionId)}
                >
                  <span class="min-w-0">
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="truncate text-base leading-snug font-semibold text-highlight">
                        ${session.title || i18n.get('session.untitled')}
                      </span>
                      <span
                        v-if=${this.permissionSessionIds.includes(session.sessionId)}
                        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-notice/10 px-2 py-0.5 text-xs font-semibold text-notice"
                        title=${i18n.get('session.permissionTip')}
                      >
                        <span class="size-1.5 animate-pulse rounded-full bg-notice"></span>
                        ${i18n.get('session.permission')}
                      </span>
                      <span
                        v-else-if=${this.pendingSessionIds.includes(session.sessionId)}
                        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-informative/10 px-2 py-0.5 text-xs font-semibold text-informative"
                        title=${i18n.get('session.runningTip')}
                      >
                        <span class="size-1.5 animate-pulse rounded-full bg-informative"></span>
                        ${i18n.get('session.running')}
                      </span>
                      <span
                        v-if=${this.unreadSessionIds.includes(session.sessionId)}
                        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-positive/10 px-2 py-0.5 text-xs font-semibold text-positive"
                        title=${i18n.get('session.completedUnreadTip')}
                      >
                        <span class="size-1.5 rounded-full bg-positive"></span>
                        ${i18n.get('session.completed')}
                      </span>
                    </span>
                    <span class="mt-1.5 block truncate font-mono text-xs text-describe">
                      ${session.sessionId}
                    </span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5 text-xs text-describe">
                    <span>
                      ${
                        session.updatedAt
                          ? new Time().relativeTimeFormat(new Time(session.updatedAt), { lang: i18n.currentLanguage })
                          : '—'
                      }
                    </span>
                    <tap-use
                      class="size-[15px]"
                      .element=${this.deletingSessionIds.includes(session.sessionId) ? icons.loading : icons.right}
                    ></tap-use>
                  </span>
                </button>
                <button
                  slot="end"
                  type="button"
                  class="flex min-w-20 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-negative px-4 text-sm font-semibold text-white active:opacity-80 disabled:cursor-default disabled:opacity-50"
                  ?disabled=${this.deletionDisabled || this.deletingSessionIds.includes(session.sessionId)}
                  aria-label=${i18n.get('sessionList.deleteAria', session.title || i18n.get('session.untitled'))}
                  @click=${(event: MouseEvent) => {
                    event.preventDefault();
                    this.requestDelete(session.sessionId);
                  }}
                >
                  <tap-use class="size-5" .element=${icons.delete}></tap-use>
                  ${i18n.get(this.deletingSessionIds.includes(session.sessionId) ? 'sessionList.deleting' : 'sessionList.delete')}
                </button>
              </tap-swipeout>
            `,
          )}
        </div>
        <footer v-if=${sessions.length > 5} class="border-t border-border/70 bg-bg-light/40">
          <button
            type="button"
            class="flex h-10 w-full cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent text-sm font-semibold text-describe transition-colors hover:text-highlight active:bg-bg-hover"
            @click=${this.#toggleExpand}
          >
            <span>${expanded ? i18n.get('session.collapse') : i18n.get('session.expandMore', String(sessions.length - 5))}</span>
            <tap-use class="size-3.5" .element=${expanded ? icons.rollup : icons.expand}></tap-use>
          </button>
        </footer>
      </section>
    `;
  };
}
