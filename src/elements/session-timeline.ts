import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';
import { markdownExtensions, markdownStyle, userMarkdownStyle } from '../lib/markdown';
import { groupTimelineMessages, type ProcessGroup } from '../session/timeline';
import type { Attachment, ChatMessage, TextMessage } from '../session/types';

const style = css`
  :scope { display: block; }
`;
@customElement('deck-session-timeline')
@adoptedStyle(style)
export class DeckSessionTimelineElement extends GemElement {
  @property sessionKey = '';
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
    >${text}</gem-bind-marked>
  `;

  #getGroupSummaryText = (group: ProcessGroup): string => {
    const toolCount = group.items.filter((item) => item.type === 'tool').length;
    const thoughtCount = group.items.filter((item) => item.type === 'thought').length;

    if (group.pending) {
      const last = group.items.at(-1);
      if (last && last.type === 'tool') {
        return `正在调用 ${last.data.title || '工具'}…`;
      }
      return '正在思考…';
    }

    if (toolCount === 0) {
      return '思考过程';
    }
    if (thoughtCount === 0) {
      return `工具调用 (${toolCount})`;
    }
    return `思考与工具 (${group.items.length})`;
  };

  #openProcessSheet = (group: ProcessGroup) => {
    this.#lastGroup = group;
    this.#state({ selectedGroupId: group.id });
  };

  #closeProcessSheet = () => {
    this.#state({ selectedGroupId: null });
  };

  #renderProcessGroup = (group: ProcessGroup) => {
    return html`
      <div class="mb-3.5 flex items-center">
        <button
          type="button"
          class=${classMap({
            'group inline-flex max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs font-medium text-describe transition-colors hover:text-text active:opacity-75': true,
            'animate-pulse': group.pending,
          })}
          @click=${() => this.#openProcessSheet(group)}
        >
          <tap-use class="size-3.5 shrink-0 text-describe transition-colors group-hover:text-text" .element=${icons.schedule}></tap-use>
          <span class="truncate">${this.#getGroupSummaryText(group)}</span>
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
              class="mt-1.5 ml-auto block cursor-pointer border-0 bg-transparent py-1 text-xs font-medium text-primary-strong disabled:cursor-default disabled:text-disabled"
              ?disabled=${!this.canRestoreInput}
              title=${this.canRestoreInput ? '将这条消息和附件恢复到输入框' : '请先清空当前输入'}
              @click=${() => this.restore(message)}
            >
              恢复输入
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
      <tap-reflect .target=${document.body}>
        <tap-sheet
          class="[&::part(sheet)]:max-w-[620px]"
          ?open=${Boolean(this.#state.selectedGroupId)}
          header="过程摘要"
          gesture
          mask-closable
          @close=${this.#closeProcessSheet}
        >
          <h2 slot="header" class="m-0 font-display text-base font-[720] text-highlight">过程摘要</h2>
          <deck-process-detail
            v-if=${Boolean(this.#state.selectedGroupId)}
            .group=${currentGroup}
          ></deck-process-detail>
        </tap-sheet>
      </tap-reflect>
    `;
  };
}
