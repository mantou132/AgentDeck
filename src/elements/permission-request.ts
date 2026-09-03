import type { Emitter } from '@mantou/gem/lib/decorators';

import type { PermissionRequest } from '../agent-api';

const style = css`
  :scope {
    display: block;
  }
`;

@customElement('deck-permission-request')
@adoptedStyle(style)
export class DeckPermissionRequestElement extends GemElement {
  @property request?: PermissionRequest;
  @emitter resolve: Emitter<string | null>;

  @template()
  #render = () => {
    if (!this.request) return html``;
    const { toolCall = {}, options = [] } = this.request;
    return html`
      <section class="mb-5 ml-9 overflow-hidden rounded-[15px] border border-notice/35 bg-bg-light shadow-card">
        <header class="px-3.5 py-3">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <h2 class="m-0 text-sm font-semibold text-highlight">需要你的许可</h2>
            <span v-if=${toolCall.kind} class="truncate font-mono text-[10px] text-describe">${toolCall.kind}</span>
          </div>
          <p class="mt-1 mb-0 truncate font-mono text-[11px] text-describe">${toolCall.title || '工具调用'}</p>
        </header>
        <details v-if=${toolCall.rawInput !== undefined} class="border-t border-border text-xs">
          <summary class="cursor-pointer px-3.5 py-2 text-describe">查看输入</summary>
          <pre
            class="m-0 max-h-44 overflow-auto border-t border-border bg-bg px-3 py-2.5 font-mono text-[10px] leading-relaxed text-text"
          >${JSON.stringify(toolCall.rawInput, null, 2)}</pre>
        </details>
        <footer class="flex flex-wrap justify-end gap-2 border-t border-border px-3 py-2.5">
          <button
            class="cursor-pointer rounded-[10px] border border-border bg-bg px-3 py-2 text-xs font-semibold text-describe active:bg-bg-hover"
            @click=${() => this.resolve(null)}
          >
            取消
          </button>
          ${options.map((option) => {
            const reject = option.kind?.startsWith('reject');
            return html`
              <button
                class=${classMap({
                  'cursor-pointer rounded-[10px] border px-3 py-2 text-xs font-semibold active:scale-[0.98]': true,
                  'border-border bg-bg text-describe': reject,
                  'border-primary bg-primary text-white': !reject,
                })}
                @click=${() => this.resolve(option.optionId)}
              >
                ${option.name}
              </button>
            `;
          })}
        </footer>
      </section>
    `;
  };
}
