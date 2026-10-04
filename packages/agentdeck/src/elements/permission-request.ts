import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { PermissionRequest } from '../agent/api';
import { i18n } from '../i18n';

const button =
  'min-h-11 flex-auto cursor-pointer whitespace-nowrap rounded-xl border px-3 py-2 text-sm font-medium active:scale-[0.98]';
const style = {
  reject: `${button} border-border bg-bg-light text-describe`,
  allowAlways: `${button} border-primary bg-bg-light text-primary`,
  allow: `${button} border-primary bg-primary text-white`,
};

type Option = NonNullable<PermissionRequest['options']>[number];

// Reject on the left, one-time allow (primary) on the right.
const rank = ({ kind }: Option) => (kind?.startsWith('reject') ? 0 : kind === 'allow_always' ? 1 : 2);
const styles = [style.reject, style.allowAlways, style.allow];

@customElement('deck-permission-request')
@adoptedStyle(blockContainer)
export class DeckPermissionRequestElement extends GemElement {
  @property request?: PermissionRequest;
  @emitter resolve: Emitter<string | null>;

  @template()
  #render = () => {
    if (!this.request) return html``;
    const { toolCall = {}, options = [] } = this.request;
    const sorted = [...options].sort((a, b) => rank(a) - rank(b));
    return html`
      <section class="flex max-h-[45dvh] flex-col overflow-hidden rounded-2xl border border-notice/70 bg-bg-light">
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pt-3 pb-3">
          <h2 class="m-0 text-sm font-semibold text-highlight">${i18n.get('permission.title')}</h2>
          <pre
            class="select-text mt-2 mb-0 whitespace-pre-wrap break-words rounded-lg bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed text-text"
          >${toolCall.title || i18n.get('permission.toolCall')}</pre>
          <details v-if=${toolCall.rawInput !== undefined} class="mt-2 text-sm">
            <summary class="cursor-pointer py-1 text-describe">${i18n.get('permission.viewParams')}</summary>
            <pre
              class="select-text mt-1 mb-0 whitespace-pre-wrap break-words rounded-lg bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed text-text"
            >${JSON.stringify(toolCall.rawInput, null, 2)}</pre>
          </details>
        </div>
        <footer class="flex shrink-0 flex-wrap gap-2 border-t border-border px-3 py-2.5">
          <button v-if=${!sorted.some((option) => rank(option) === 0)} class=${style.reject} @click=${() => this.resolve(null)}>
            ${i18n.get('permission.cancel')}
          </button>
          ${sorted.map(
            (option) =>
              html`<button class=${styles[rank(option)]} @click=${() => this.resolve(option.optionId)}>${option.name}</button>`,
          )}
        </footer>
      </section>
    `;
  };
}
