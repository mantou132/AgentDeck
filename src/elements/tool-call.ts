import { icons } from '@mantou/tap-ui/lib/icons';

import type { ToolCallData } from '../store';

const toolStatusLabel = {
  pending: '等待中',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
} as const;

const toolStatusDotClass = {
  pending: 'bg-informative animate-pulse',
  in_progress: 'bg-informative animate-pulse',
  completed: 'bg-positive',
  failed: 'bg-negative',
} as const;

const style = css`
  :scope {
    display: block;
  }

  summary::-webkit-details-marker {
    display: none;
  }
`;

@customElement('deck-tool-call')
@adoptedStyle(style)
export class DeckToolCallElement extends GemElement {
  @property data?: ToolCallData;

  @template()
  #render = () => {
    if (!this.data) return html``;
    const { title, kind, status = 'pending', rawInput } = this.data;
    return html`
      <details
        class="mt-0.5 mb-[17px] overflow-hidden rounded-[13px] border border-border bg-bg-light/70 text-xs text-describe"
        ?open=${status === 'in_progress' || status === 'failed'}
      >
        <summary
          class="grid min-h-[46px] cursor-pointer list-none grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-2"
        >
          <span class="grid size-7 place-items-center rounded-[9px] bg-primary-soft text-primary-strong">
            <tap-use class="size-3.5" .element=${icons.tune}></tap-use>
          </span>
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-text">${title}</span>
            <span class="mt-0.5 block font-mono text-[11px]">${kind || 'tool'}</span>
          </span>
          <span class="flex items-center gap-1.5 whitespace-nowrap font-semibold text-describe">
            <span class=${`size-[7px] rounded-full ${toolStatusDotClass[status]}`}></span>
            ${toolStatusLabel[status]}
          </span>
        </summary>
        <pre
          v-if=${rawInput !== undefined}
          class="m-0 max-h-[210px] overflow-auto whitespace-pre-wrap border-t border-border bg-bg/70 px-3 py-2.5 font-mono text-[11px] leading-normal text-describe"
        >${JSON.stringify(rawInput, null, 2)}</pre>
      </details>
    `;
  };
}
