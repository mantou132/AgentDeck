import type { Emitter } from '@mantou/gem/lib/decorators';
import { i18n } from '../i18n';
import { getCodeLang, isSmallTextFile } from '../lib/file-preview';
import type { Attachment } from '../session/types';

@customElement('deck-attachment-preview')
export class DeckAttachmentPreviewElement extends GemElement {
  @property attachment?: Attachment | null;
  @emitter close: Emitter;

  @template()
  #render = () => {
    const attachment = this.attachment;
    const isImage = attachment?.kind === 'image';
    const text = attachment?.kind === 'text' ? attachment.text : '';
    const isSmall = isSmallTextFile(text);
    const lang = attachment?.name ? getCodeLang(attachment.name) : '';

    return html`
      <deck-sheet
        ?open=${Boolean(attachment)}
        .heading=${attachment?.name || i18n.get('attachment.previewHeading')}
        .description=${isImage ? i18n.get('attachment.imageDesc') : i18n.get('attachment.textDesc')}
        @close=${() => this.close()}
        .content=${html`
          ${
            isImage
              ? html`
                  <img class="mx-auto block max-h-[65dvh] max-w-full rounded-xl object-contain" src=${attachment.previewUrl} alt=${attachment.name} />
                `
              : isSmall
                ? html`
                    <tap-code-block codelang=${lang} class="m-0 max-h-[65dvh] overflow-auto rounded-xl bg-bg">${text}</tap-code-block>
                  `
                : html`
                    <pre class="m-0 max-h-[65dvh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-bg p-4 font-mono text-sm leading-relaxed text-text">${text}</pre>
                  `
          }
        `}
      ></deck-sheet>
    `;
  };
}
