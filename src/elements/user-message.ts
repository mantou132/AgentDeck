import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { openMessageLink } from '../navigation';
import { extractDataImageAttachments } from '../session/timeline';
import type { Attachment, TextMessage } from '../session/types';
import { icons } from '../styles/icons';

@customElement('deck-user-message')
@adoptedStyle(blockContainer)
export class DeckUserMessageElement extends GemElement {
  @property sessionKey = '';
  @property cwd = '';
  @property message?: TextMessage;
  @emitter preview: Emitter<Attachment>;

  #state = createState({
    expanded: false,
    overflowing: false,
  });

  #innerRef = createRef<HTMLElement>();

  get #isLikelyOverflowing() {
    const text = this.message?.text || '';
    return text.length > 200 || text.split('\n').length > 5;
  }

  @effect((i) => [i.#innerRef.value, i.message?.text])
  #checkOverflow = () => {
    const inner = this.#innerRef.value;
    if (!inner) return;

    const measure = () => {
      const fontSize = parseFloat(getComputedStyle(this).fontSize) || 16;
      const maxCollapsedHeight = 8.5 * fontSize;
      const overflowing = inner.offsetHeight > maxCollapsedHeight + 4;
      if (this.#state.overflowing !== overflowing) {
        this.#state({ overflowing });
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  };

  #toggleExpand = (event: MouseEvent) => {
    event.stopPropagation();
    const nextExpanded = !this.#state.expanded;
    this.#state({ expanded: nextExpanded });
    if (!nextExpanded) {
      this.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  @template()
  #render = () => {
    const message = this.message;
    if (!message) return html``;

    const { attachments: linkedAttachments, markdown } = extractDataImageAttachments(message.text);
    const attachments = [...(message.attachments ?? []), ...linkedAttachments];
    const isStreaming = !!message.streaming;
    const isCollapsed = !isStreaming && !this.#state.expanded && (this.#state.overflowing || this.#isLikelyOverflowing);
    const showToggle = !isStreaming && this.#state.overflowing;

    return html`
      <div class="mb-[18px] flex justify-end">
        <div class="max-w-[min(86%,560px)]">
          <div class="overflow-hidden rounded-[19px_19px_5px_19px] bg-primary px-4 py-3 text-base leading-[1.6] text-white shadow-primary">
            <div v-if=${attachments.length} class="mb-2 flex flex-wrap justify-end gap-2">
              ${attachments.map(
                (attachment) => html`
                  <deck-attachment
                    .attachment=${attachment}
                    @preview=${(event: CustomEvent<Attachment>) => this.preview(event.detail)}
                  ></deck-attachment>
                `,
              )}
            </div>
            <div class="relative">
              <div
                class=${classMap({
                  'overflow-hidden transition-[max-height] duration-200': true,
                  'max-h-[8.5em]': isCollapsed,
                })}
              >
                <div ${this.#innerRef}>
                  <deck-stream-markdown
                    .text=${markdown}
                    .streamKey=${`${this.sessionKey}:${message.id}`}
                    ?streaming=${message.streaming}
                    ?user=${true}
                    @click=${(event: MouseEvent) => openMessageLink(event, this.cwd)}
                  ></deck-stream-markdown>
                </div>
              </div>
              <div
                v-if=${isCollapsed}
                class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-primary to-transparent"
              ></div>
            </div>
            <div v-if=${showToggle} class="mt-2 flex justify-center">
              <button
                type="button"
                class="inline-flex cursor-pointer items-center justify-center gap-1 rounded-full bg-white/15 px-3 py-0.5 text-xs font-medium text-white shadow-xs transition-colors hover:bg-white/25 active:bg-white/30"
                @click=${this.#toggleExpand}
              >
                <span>${this.#state.expanded ? i18n.get('timeline.collapseMessage') : i18n.get('timeline.expandMessage')}</span>
                <tap-use class="size-3" .element=${this.#state.expanded ? icons.rollup : icons.expand}></tap-use>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  };
}
