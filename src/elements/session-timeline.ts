import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';
import { i18n } from '../i18n';
import { markdownExtensions, markdownStyle, userMarkdownStyle } from '../lib/markdown';
import { openMessageLink } from '../navigation';
import { getProcessSummary, groupTimelineMessages, type ProcessGroup } from '../session/timeline';
import type { Attachment, ChatMessage, TextMessage } from '../session/types';

const style = css`
  :scope { display: block; }
`;

@customElement('deck-session-timeline')
@adoptedStyle(style)
export class DeckSessionTimelineElement extends GemElement {
  @property sessionKey = '';
  @property cwd = '';
  @property messages: ChatMessage[] = [];
  @boolattribute pending: boolean;
  @boolattribute canRestoreInput: boolean;
  @emitter restore: Emitter<TextMessage>;
  @emitter preview: Emitter<Attachment>;
  #state = createState({ selectedGroupId: null as string | null });
  #lastGroup?: ProcessGroup;

  @effect((i) => [i.sessionKey])
  #resetSelection = () => {
    this.#state({ selectedGroupId: null });
    this.#lastGroup = undefined;
  };

  #renderMarkdown = (text: string, streaming = false, user = false) => html`
    <gem-bind-marked
      ?streaming=${streaming}
      .mdStyle=${user ? userMarkdownStyle : markdownStyle}
      .extensions=${markdownExtensions}
      @click=${(event: MouseEvent) => openMessageLink(event, this.cwd)}
    >${text}</gem-bind-marked>
  `;

  #openProcessSheet = (group: ProcessGroup) => {
    this.#lastGroup = group;
    this.#state({ selectedGroupId: group.id });
  };

  #closeProcessSheet = () => {
    this.#state({ selectedGroupId: null });
  };

  #renderProcessGroup = (group: ProcessGroup) => {
    const summary = getProcessSummary(group);
    return html`
      <div class="mb-3 flex min-w-0 items-center">
        <button
          type="button"
          class="inline-flex min-h-11 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl border-0 bg-transparent py-2 pr-2 text-left text-sm text-describe outline-none transition-colors active:bg-bg-hover"
          title=${summary}
          @click=${() => this.#openProcessSheet(group)}
        >
          <tap-use class="size-4 shrink-0" .element=${group.pending ? icons.loading : icons.schedule}></tap-use>
          <span class="min-w-0 truncate">${summary}</span>
          <tap-use class="size-3.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>
        </button>
      </div>
    `;
  };

  #renderTextMessage = (message: TextMessage) => {
    if (message.role === 'user') {
      return html`
        <div class="mb-[18px] flex justify-end">
          <div class="max-w-[min(86%,560px)]">
            <div class="overflow-hidden rounded-[19px_19px_5px_19px] bg-primary px-4 py-3 text-base leading-[1.6] text-white shadow-primary">
              <div v-if=${message.attachments?.length} class="mb-2 flex flex-wrap justify-end gap-2">
                ${message.attachments?.map(
                  (attachment) => html`
                    <deck-attachment .attachment=${attachment} @preview=${(event: CustomEvent<Attachment>) => this.preview(event.detail)}></deck-attachment>
                  `,
                )}
              </div>
              ${this.#renderMarkdown(message.text, message.streaming, true)}
            </div>
            <button
              v-if=${message.failed}
              type="button"
              class="mt-1.5 ml-auto block cursor-pointer border-0 bg-transparent py-1 text-sm font-medium text-primary-strong disabled:cursor-default disabled:text-disabled"
              ?disabled=${!this.canRestoreInput}
              title=${this.canRestoreInput ? i18n.get('timeline.restoreInputTitle') : i18n.get('timeline.clearInputFirst')}
              @click=${() => this.restore(message)}
            >
              ${i18n.get('timeline.restoreInput')}
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <article class="mb-5 min-w-0 text-base leading-[1.68] text-text">
        <div v-if=${message.attachments?.length} class="mb-2 flex flex-wrap gap-2">
          ${message.attachments?.map(
            (attachment) => html`
              <deck-attachment .attachment=${attachment} @preview=${(event: CustomEvent<Attachment>) => this.preview(event.detail)}></deck-attachment>
            `,
          )}
        </div>
        ${this.#renderMarkdown(message.text, message.streaming)}
      </article>
    `;
  };

  @template()
  #render = () => {
    const timelineItems = groupTimelineMessages(this.messages, this.pending);
    const selectedGroup = this.#state.selectedGroupId
      ? timelineItems.find(
          (item): item is { type: 'group'; group: ProcessGroup } =>
            item.type === 'group' && item.group.id === this.#state.selectedGroupId,
        )?.group
      : undefined;
    if (selectedGroup) {
      this.#lastGroup = selectedGroup;
    }
    const currentGroup = selectedGroup || this.#lastGroup;
    return html`
      ${timelineItems.map((item) => (item.type === 'group' ? this.#renderProcessGroup(item.group) : this.#renderTextMessage(item.message)))}
      <deck-sheet
        ?open=${Boolean(this.#state.selectedGroupId)}
        .heading=${i18n.get('timeline.processSummary')}
        @close=${this.#closeProcessSheet}
        .content=${html`
          <deck-process-detail
            v-if=${Boolean(this.#state.selectedGroupId)}
            .group=${currentGroup}
            .cwd=${this.cwd}
            @navigate=${this.#closeProcessSheet}
          ></deck-process-detail>
        `}
      ></deck-sheet>
    `;
  };
}
