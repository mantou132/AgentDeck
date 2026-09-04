import { icons } from '@mantou/tap-ui/lib/icons';

import { markdownExtensions, markdownStyle } from '../markdown';
import type { ThoughtMessage, ToolMessage } from '../store';
import { toolStatusDotClass, toolStatusLabel } from './tool-call';

export type NonFormalItem = ThoughtMessage | ToolMessage;

export type NonFormalGroup = {
  id: string;
  items: NonFormalItem[];
  pending: boolean;
};

const style = css`
  :scope {
    display: block;
  }

  summary::-webkit-details-marker {
    display: none;
  }
`;

@customElement('deck-process-detail')
@adoptedStyle(style)
export class DeckProcessDetailElement extends GemElement {
  @property group?: NonFormalGroup;

  @template()
  #render = () => {
    const { group } = this;
    if (!group?.items.length) {
      return html`
        <div class="py-8 text-center text-xs text-describe">暂无过程记录</div>
      `;
    }

    return html`
      <div class="px-1 pt-1 pb-6">
        <div class="flex flex-col">
          ${group.items.map((item, index) => {
            const isLast = index === group.items.length - 1;
            const isThought = item.type === 'thought';
            const isPending =
              (isThought && item.pending) ||
              (!isThought && (item.data.status === 'pending' || item.data.status === 'in_progress'));

            let icon = icons.tune;
            if (isThought) {
              icon = icons.schedule;
            } else {
              const kind = item.data.kind?.toLowerCase() || '';
              const title = item.data.title?.toLowerCase() || '';
              if (
                kind.includes('search') ||
                title.includes('search') ||
                title.includes('find') ||
                title.includes('grep')
              ) {
                icon = icons.search;
              } else if (kind.includes('read') || title.includes('read')) {
                icon = icons.visibility;
              }
            }

            const title = isThought ? (item.pending ? '正在思考…' : '思考过程') : item.data.title;
            const subtitle = !isThought ? item.data.kind || 'tool' : '';
            const status = !isThought ? item.data.status || 'pending' : item.pending ? 'in_progress' : 'completed';
            const statusLabel = toolStatusLabel[status];
            const statusDotClass = toolStatusDotClass[status];

            return html`
              <div class="flex gap-3">
                <div class="flex flex-col items-center">
                  <span
                    class=${classMap({
                      'grid size-6 shrink-0 place-items-center rounded-full border text-xs z-[1]': true,
                      'border-primary/40 bg-primary-soft text-primary-strong': isPending,
                      'border-border bg-bg-light text-describe': !isPending,
                    })}
                  >
                    <tap-use class="size-3" .element=${icon}></tap-use>
                  </span>
                  <span v-if=${!isLast} class="w-px flex-1 bg-border/70 my-1"></span>
                </div>

                <div class="min-w-0 flex-1 pb-4">
                  <details class="group/step">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
                      <div class="flex min-w-0 items-center gap-2">
                        <span class="truncate text-sm font-semibold text-text">${title}</span>
                        <span v-if=${subtitle} class="rounded-md bg-bg px-1.5 py-0.5 font-mono text-[10px] text-describe">
                          ${subtitle}
                        </span>
                      </div>
                      <div class="flex shrink-0 items-center gap-2">
                        <span v-if=${statusLabel} class="flex items-center gap-1.5 text-xs text-describe">
                          <span class=${`size-1.5 rounded-full ${statusDotClass}`}></span>
                          <span>${statusLabel}</span>
                        </span>
                        <tap-use class="size-3 text-disabled transition-transform group-open/step:rotate-90" .element=${icons.right}></tap-use>
                      </div>
                    </summary>

                    <div class="mt-2.5">
                      ${
                        isThought
                          ? html`
                            <div class="rounded-xl border border-border/70 bg-bg/50 p-3 leading-relaxed text-describe text-[13px]">
                              <gem-bind-marked
                                ?streaming=${isPending}
                                .mdStyle=${markdownStyle}
                                .extensions=${markdownExtensions}
                              >${item.text || (isPending ? '正在思考中…' : '')}</gem-bind-marked>
                            </div>
                          `
                          : html`
                            <pre
                              v-if=${item.data.rawInput !== undefined}
                              class="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-xl border border-border/70 bg-bg/70 px-3 py-2.5 font-mono text-[11px] leading-normal text-describe"
                            >${JSON.stringify(item.data.rawInput, null, 2)}</pre>
                          `
                      }
                    </div>
                  </details>
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  };
}
