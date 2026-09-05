import type { TemplateResult } from '@mantou/gem';
import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';

const style = css`
  :scope { display: contents; }

  tap-sheet::part(sheet) {
    max-width: 620px;
    border: 1px solid var(--color-border);
    border-bottom: 0;
    border-radius: 24px 24px 0 0;
    background: var(--color-bg-light);
    padding: 0 20px calc(20px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }

  tap-sheet::part(header) {
    padding: 4px 0 20px;
  }
`;

@customElement('deck-sheet')
@adoptedStyle(style)
export class DeckSheetElement extends GemElement {
  @boolattribute open: boolean;
  @property heading = '';
  @property description = '';
  @property content?: TemplateResult;
  @emitter close: Emitter;

  @template()
  #render = () => html`
    <tap-sheet
      ?open=${this.open}
      header=${this.heading}
      gesture
      mask-closable
      @close=${() => this.close()}
    >
      <div slot="header" class="flex items-start gap-4 text-left">
        <div class="min-w-0 flex-1 pt-1.5">
          <h2 class="m-0 break-words font-display text-lg leading-snug font-semibold tracking-tight text-highlight">${this.heading}</h2>
          <p v-if=${this.description} class="mt-1.5 mb-0 text-sm leading-relaxed font-normal text-describe">${this.description}</p>
        </div>
        <button
          type="button"
          class="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-bg text-describe outline-none transition-colors active:bg-bg-hover"
          aria-label="关闭"
          @click=${() => this.close()}
        >
          <tap-use class="size-[18px]" .element=${icons.close}></tap-use>
        </button>
      </div>
      ${this.content}
    </tap-sheet>
  `;
}
