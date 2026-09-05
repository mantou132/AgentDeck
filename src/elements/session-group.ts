import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';
import { Time } from '@mantou/tap-ui/lib/time';

import { displayPath } from '../lib/path';
import type { DeckSession } from '../session/types';

const style = css`
  :scope {
    display: block;
  }
`;

@customElement('deck-session-group')
@adoptedStyle(style)
export class DeckSessionGroupElement extends GemElement {
  @property cwd = '';
  @property sessions: DeckSession[] = [];
  @emitter select: Emitter<string>;

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
            <span class="font-mono text-xs font-bold">/</span>
          </span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-highlight" title=${cwd}>
            ${displayPath(cwd)}
          </span>
          <span class="rounded-lg bg-bg px-2 py-1 font-mono text-xs font-bold text-describe">${sessions.length}</span>
        </header>
        <div>
          ${visibleSessions.map(
            (session) => html`
              <button
                class="grid min-h-[72px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-0 border-b border-solid border-border/70 bg-transparent px-4 py-3 text-left text-text transition-colors duration-150 last:border-b-0 active:bg-bg-hover"
                @click=${() => this.select(session.sessionId)}
              >
                <span class="min-w-0">
                  <span class="block truncate text-base leading-snug font-semibold text-highlight">
                    ${session.title || '未命名会话'}
                  </span>
                  <span class="mt-1.5 block truncate font-mono text-xs text-describe">
                    ${session.sessionId}
                  </span>
                </span>
                <span class="flex shrink-0 items-center gap-1.5 text-xs text-disabled">
                  <span>
                    ${
                      session.updatedAt
                        ? new Time().relativeTimeFormat(new Time(session.updatedAt), { lang: 'zh-CN' })
                        : '—'
                    }
                  </span>
                  <tap-use class="size-[15px]" .element=${icons.right}></tap-use>
                </span>
              </button>
            `,
          )}
        </div>
        <footer v-if=${sessions.length > 5} class="border-t border-border/70 bg-bg-light/40">
          <button
            type="button"
            class="flex h-10 w-full cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent text-sm font-semibold text-describe transition-colors hover:text-highlight active:bg-bg-hover"
            @click=${this.#toggleExpand}
          >
            <span>${expanded ? '收起会话' : `展开其余 ${sessions.length - 5} 个会话`}</span>
            <tap-use class="size-3.5" .element=${expanded ? icons.rollup : icons.expand}></tap-use>
          </button>
        </footer>
      </section>
    `;
  };
}
