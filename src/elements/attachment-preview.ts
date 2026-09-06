import type { Emitter } from '@mantou/gem/lib/decorators';
import { i18n } from '../i18n';
import type { Attachment } from '../session/types';

@customElement('deck-attachment-preview')
export class DeckAttachmentPreviewElement extends GemElement {
  @property attachment?: Attachment | null;
  @emitter close: Emitter;

  @template()
  #render = () => html`
    <deck-sheet
      ?open=${Boolean(this.attachment)}
      .heading=${this.attachment?.name || i18n.get('attachment.previewHeading')}
      .description=${this.attachment?.kind === 'image' ? i18n.get('attachment.imageDesc') : i18n.get('attachment.textDesc')}
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
  `;
}
