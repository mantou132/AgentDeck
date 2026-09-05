import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';
import type { Attachment } from '../session/types';

const style = css`tap-sheet::part(sheet) { max-width: 620px; }`;
@customElement('deck-attachment-preview')
@adoptedStyle(style)
export class DeckAttachmentPreviewElement extends GemElement {
  @property attachment?: Attachment | null;
  @emitter close: Emitter;

  @template()
  #render = () => html`
      <tap-sheet
        ?open=${Boolean(this.attachment)}
        header="附件预览"
        gesture
        mask-closable
        @close=${() => this.close()}
      >
        <div slot="header" class="flex min-w-0 items-center gap-3">
          <h2 class="m-0 min-w-0 flex-1 truncate font-display text-base font-[720] text-highlight">${this.attachment?.name}</h2>
          <button
            type="button"
            class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-xl border-0 bg-bg text-describe active:bg-bg-hover"
            aria-label="关闭附件预览"
            @click=${() => this.close()}
          >
            <tap-use class="size-4" .element=${icons.close}></tap-use>
          </button>
        </div>
        <div class="max-h-[70dvh] overflow-auto px-4 pb-5">
          ${
            this.attachment?.kind === 'image'
              ? html`
                  <img class="mx-auto max-h-[65dvh] max-w-full rounded-xl object-contain" src=${this.attachment.previewUrl} alt=${this.attachment.name} />
                `
              : html`
                  <pre class="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-text">${this.attachment?.text}</pre>
                `
          }
        </div>
      </tap-sheet>
  `;
}
