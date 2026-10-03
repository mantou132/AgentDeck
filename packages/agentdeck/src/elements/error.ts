import type { TemplateResult } from '@mantou/gem';
import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { icons } from '../styles/icons';

/** Full-page error state: heading, error message, and retry button; `actions` are appended after the retry button */
@customElement('deck-error')
@adoptedStyle(blockContainer)
@aria({ role: 'alert' })
export class DeckErrorElement extends GemElement {
  @attribute heading: string;
  @attribute error: string;
  @property actions?: TemplateResult;
  @emitter retry: Emitter<null>;

  @template()
  #render = () => html`
    <div class="mx-auto max-w-lg px-5 py-16 text-center">
      <tap-use class="mb-3 size-8 text-negative" .element=${icons.error}></tap-use>
      <p class="m-0 font-semibold text-highlight">${this.heading}</p>
      <p class="select-text mt-2 text-sm break-words text-negative">${this.error}</p>
      <div class="mt-4 flex justify-center gap-3">
        <button
          class="min-h-11 cursor-pointer rounded-xl border border-primary/20 bg-primary-soft px-5 text-sm font-semibold text-primary-strong active:scale-[0.98]"
          @click=${() => this.retry(null)}
        >
          ${i18n.get('global.retry')}
        </button>
        ${this.actions}
      </div>
    </div>
  `;
}
