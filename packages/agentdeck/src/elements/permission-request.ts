import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { PermissionRequest } from '../agent/api';
import { i18n } from '../i18n';

@customElement('deck-permission-request')
@adoptedStyle(blockContainer)
export class DeckPermissionRequestElement extends GemElement {
  @property request?: PermissionRequest;
  @emitter resolve: Emitter<string | null>;

  @template()
  #render = () => {
    if (!this.request) return html``;
    const { toolCall = {}, options = [] } = this.request;
    return html`
      <section class="max-h-[45dvh] overflow-y-auto rounded-2xl border border-notice/35 bg-bg-light overscroll-y-contain">
        <header class="px-4 pt-3.5 pb-3">
          <h2 class="m-0 text-base font-semibold text-highlight">${i18n.get('permission.title')}</h2>
          <p class="mt-2 mb-0 break-words font-mono text-sm leading-relaxed text-text">${toolCall.title || i18n.get('permission.toolCall')}</p>
        </header>
        <details v-if=${toolCall.rawInput !== undefined} class="border-t border-border text-sm">
          <summary class="cursor-pointer px-4 py-3 text-describe">${i18n.get('permission.viewParams')}</summary>
          <pre
            class="m-0 max-h-44 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-bg px-4 py-3 font-mono text-sm leading-relaxed text-text"
          >${JSON.stringify(toolCall.rawInput, null, 2)}</pre>
        </details>
        <footer class="flex flex-wrap justify-end gap-2 border-t border-border px-3 py-3">
          <button
            class="min-h-11 cursor-pointer rounded-xl border border-border bg-bg-light px-4 py-2 text-sm font-medium text-describe active:bg-bg-hover"
            @click=${() => this.resolve(null)}
          >
            ${i18n.get('permission.cancel')}
          </button>
          ${options.map((option) => {
            const reject = option.kind?.startsWith('reject');
            return html`
              <button
                class=${classMap({
                  'min-h-11 cursor-pointer rounded-xl border px-4 py-2 text-sm font-medium active:scale-[0.98]': true,
                  'border-border bg-bg-light text-describe': reject,
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
