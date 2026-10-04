import { addListener } from '@mantou/gem';
import type { Emitter } from '@mantou/gem/lib/decorators';
import { repeat } from '@mantou/gem/lib/element';
import { Sheet } from '@mantou/tap-ui/elements/sheet';
import { closestElement } from '@mantou/tap-ui/lib/element';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { setSelectionMenuItems } from 'src/lib/selection-menu';
import { i18n } from '../i18n';
import { openMessageLink } from '../navigation';
import {
  extractDataImageAttachments,
  getProcessSummary,
  getToolStatus,
  groupTimelineMessages,
  type ProcessGroup,
} from '../session/timeline';
import type { Attachment, ChatMessage, TextMessage } from '../session/types';
import { stripVoiceChatMarker } from '../session/voice-chat';
import { icons } from '../styles/icons';

@customElement('deck-session-timeline')
@adoptedStyle(blockContainer)
export class DeckSessionTimelineElement extends GemElement {
  @property sessionKey = '';
  @property cwd = '';
  @property messages: ChatMessage[] = [];
  @boolattribute pending: boolean;
  @emitter preview: Emitter<Attachment>;
  @emitter ask: Emitter<string>;

  #renderMarkdown = (text: string, streamKey = '', streaming = false, user = false) => html`
    <deck-stream-markdown
      .text=${text}
      .streamKey=${streamKey}
      ?streaming=${streaming}
      ?user=${user}
      cwd=${this.cwd}
      @click=${(event: MouseEvent) => openMessageLink(event, this.cwd)}
    ></deck-stream-markdown>
  `;

  #openProcessSheet = (group: ProcessGroup) => {
    Sheet.open({
      maskClosable: true,
      hasStack: true,
      snap: true,
      body: html`
        <deck-process-detail .sessionId=${this.sessionKey} .groupId=${group.id}></deck-process-detail>
      `,
    });
  };

  #renderProcessGroup = (group: ProcessGroup) => {
    const summary = getProcessSummary(group);
    const hasTools = group.items.some((item) => item.type === 'tool');
    const hasFailed = group.items.some(
      (item) => item.type === 'tool' && getToolStatus(item.data, group.pending) === 'failed',
    );
    const icon = group.pending ? icons.loading : hasFailed ? icons.error : hasTools ? icons.terminal : icons.sparkles;

    return html`
      <div class="mb-2 flex min-w-0 items-center">
        <button
          type="button"
          class="-mx-2 inline-flex min-h-10 max-w-[calc(100%+1rem)] min-w-0 cursor-pointer items-center gap-2 rounded-xl border-0 bg-transparent px-2 py-1.5 text-left text-sm text-describe outline-none transition-colors hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-focus active:bg-bg-hover"
          title=${summary}
          @click=${() => this.#openProcessSheet(group)}
        >
          <tap-use
            class=${classMap({
              'size-4 shrink-0': true,
              'text-primary-strong': group.pending,
              'text-negative': !group.pending && hasFailed,
            })}
            .element=${icon}
          ></tap-use>
          <span class="min-w-0 truncate">${summary}</span>
          <tap-use class="size-3.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>
        </button>
      </div>
    `;
  };

  #renderTextMessage = (message: TextMessage) => {
    const { attachments: linkedAttachments, markdown } = extractDataImageAttachments(
      message.role === 'user' ? stripVoiceChatMarker(message.text) : message.text,
    );
    const attachments = [...(message.attachments ?? []), ...linkedAttachments];

    if (message.role === 'user') {
      return html`
        <div class="mt-8 mb-4 flex justify-end first:mt-0">
          <div class="flex max-w-[min(86%,560px)] flex-col items-end">
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
            <div
              v-if=${!!markdown.trim()}
              class="max-w-full overflow-hidden rounded-[19px_19px_5px_19px] bg-primary-soft px-4 py-3 text-base leading-[1.6] text-highlight"
            >
              <deck-foldable
                size="small"
                cwd=${this.cwd}
                label=${i18n.get('timeline.userMessage')}
                .markdown=${markdown}
                ?disabled=${message.streaming}
              >
                ${this.#renderMarkdown(markdown, `${this.sessionKey}:${message.id}`, message.streaming, true)}
              </deck-foldable>
            </div>
          </div>
        </div>
      `;
    }

    return html`
      <article @pointerdown=${this.#setSelectionMenu} class="agent-message mb-4 min-w-0 text-base leading-[1.68] text-text">
        <div v-if=${attachments.length} class="mb-2 flex flex-wrap gap-2">
          ${attachments.map(
            (attachment) => html`
              <deck-attachment .attachment=${attachment} @preview=${(event: CustomEvent<Attachment>) => this.preview(event.detail)}></deck-attachment>
            `,
          )}
        </div>
        ${this.#renderMarkdown(markdown, `${this.sessionKey}:${message.id}`, message.streaming)}
      </article>
    `;
  };

  #setSelectionMenu = () => {
    const selection = window.getSelection();
    const ele = selection?.anchorNode?.parentElement;
    if (!ele || !selection.toString().trim()) return;
    if (!closestElement(ele, 'deck-session-timeline .agent-message')) return;
    setSelectionMenuItems({ items: [{ label: 'Ask', onClick: ({ text }) => this.ask(text) }] });
  };

  @mounted()
  #initSelectionChange = () => {
    return addListener(document, 'selectionchange', this.#setSelectionMenu);
  };

  @template()
  #render = () => {
    const timelineItems = groupTimelineMessages(
      this.messages.filter((message) => !('failed' in message && message.failed)),
      this.pending,
    );
    const last = timelineItems.at(-1);

    return html`
      ${repeat(
        timelineItems,
        (item) => (item.type === 'group' ? item.group.id : item.message.id),
        (item) =>
          item.type === 'group' ? this.#renderProcessGroup(item.group) : this.#renderTextMessage(item.message),
      )}
      <div
        v-if=${this.pending && last?.type === 'message' && last.message.role === 'user'}
        role="status"
        class="mb-2 flex min-h-10 items-center gap-2 text-sm text-describe"
      >
        <tap-use class="size-4 shrink-0 text-primary-strong" .element=${icons.loading}></tap-use>
        ${i18n.get('timeline.thinking')}
      </div>
    `;
  };
}
