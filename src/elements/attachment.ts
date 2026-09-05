import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';

import type { Attachment } from '../session-runtime';

const style = css`
  :scope {
    display: block;
    min-width: 0;
    max-width: 100%;
  }
`;

@customElement('deck-attachment')
@adoptedStyle(style)
export class DeckAttachmentElement extends GemElement {
  @property attachment?: Attachment;
  @boolattribute compact: boolean;
  @boolattribute removable: boolean;
  @emitter preview: Emitter<Attachment>;
  @emitter requestRemove: Emitter<string>;

  @template()
  #render = () => {
    const attachment = this.attachment;
    if (!attachment) return html``;
    return html`
      <div class="relative max-w-full">
        <button
          type="button"
          class=${classMap({
            'max-w-full cursor-pointer overflow-hidden rounded-xl border border-border bg-bg-light text-left text-text active:bg-bg-hover': true,
            'flex w-44 items-center gap-2 p-2': this.compact || attachment.kind === 'text',
            'block p-1': !this.compact && attachment.kind === 'image',
          })}
          aria-label=${`查看附件“${attachment.name}”`}
          @click=${() => this.preview(attachment)}
        >
          <img
            v-if=${attachment.kind === 'image'}
            class=${this.compact ? 'size-10 shrink-0 rounded-lg object-cover' : 'max-h-52 max-w-full rounded-lg'}
            src=${attachment.kind === 'image' ? attachment.previewUrl : ''}
            alt=""
          />
          <span
            v-else
            class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-[10px] font-bold text-primary-strong"
          >TXT</span>
          <span class=${this.compact || attachment.kind === 'text' ? 'min-w-0 flex-1' : 'block px-1.5 py-1'}>
            <span class="block truncate text-xs font-medium">${attachment.name}</span>
            <span v-if=${this.compact || attachment.kind === 'text'} class="block text-[10px] text-describe">
              ${attachment.kind === 'image' ? '图片' : '文本'}
            </span>
          </span>
        </button>
        <button
          v-if=${this.removable}
          type="button"
          class="absolute -top-2 -right-2 grid size-7 cursor-pointer place-items-center rounded-full border border-border bg-bg-light text-describe shadow-card active:bg-bg-hover"
          aria-label=${`删除附件“${attachment.name}”`}
          @click=${() => this.requestRemove(attachment.id)}
        >
          <tap-use class="size-3.5" .element=${icons.close}></tap-use>
        </button>
      </div>
    `;
  };
}
