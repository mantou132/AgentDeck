import type { Emitter } from '@mantou/gem/lib/decorators';
import type { Attachment } from '../session/types';

@customElement('deck-attachment-preview')
export class DeckAttachmentPreviewElement extends GemElement {
  @property attachment?: Attachment | null;
  @emitter close: Emitter;

  @template()
  #render = () => html`
    <tap-reflect .target=${document.body}>
      <deck-sheet
        ?open=${Boolean(this.attachment)}
        .heading=${this.attachment?.name || '附件预览'}
        .description=${this.attachment?.kind === 'image' ? '图片附件' : '文本附件'}
        @close=${() => this.close()}
        .content=${html`
          ${
            this.attachment?.kind === 'image'
              ? html`
                  <img class="mx-auto block max-h-[65dvh] max-w-full rounded-xl object-contain" src=${this.attachment.previewUrl} alt=${this.attachment.name} />
                `
              : html`
                  <pre class="m-0 whitespace-pre-wrap break-words rounded-xl bg-bg p-4 font-mono text-sm leading-relaxed text-text">${this.attachment?.text}</pre>
                `
          }
        `}
      ></deck-sheet>
    </tap-reflect>
  `;
}
