import { addListener } from '@mantou/gem';
import type { Emitter } from '@mantou/gem/lib/decorators';
import { repeat } from '@mantou/gem/lib/element';
import type { CalloutItem } from '@mantou/tap-ui/elements/callout';
import { Sheet } from '@mantou/tap-ui/elements/sheet';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { closestElement } from '@mantou/tap-ui/lib/element';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { setSelectionMenuItems } from 'src/lib/selection-menu';
import type { ElicitationResponse } from '../agent/api';
import { extractMessageAttachments } from '../attachment/message';
import type { Attachment } from '../attachment/types';
import { i18n } from '../i18n';
import { hapticImpact } from '../lib/haptics';
import { openMessageLink } from '../navigation';
import type { Elicitation } from '../session/elicitation';
import { getProcessSummary, getToolStatus, groupTimelineMessages, type ProcessGroup } from '../session/timeline';
import type { ChatMessage, TextMessage } from '../session/types';
import { stripVoiceChatMarker } from '../session/voice-chat';
import { answerElicitation } from '../state/user-input';
import { icons } from '../styles/icons';
import { DeckStreamMarkdownElement } from './stream-markdown';

/** Fork up to the agent message `messageId`, then edit and resend the user message that followed it. */
export type ForkRequest = { messageId: string; text: string; attachments: Attachment[] };

@customElement('deck-session-timeline')
@adoptedStyle(blockContainer)
export class DeckSessionTimelineElement extends GemElement {
  @property sessionKey = '';
  @property cwd = '';
  @property messages: ChatMessage[] = [];
  @property elicitations: Elicitation[] = [];
  @boolattribute pending: boolean;
  /** The agent can fork at a given message. */
  @boolattribute forkable: boolean;
  @emitter preview: Emitter<Attachment>;
  @emitter quote: Emitter<string>;
  @emitter fork: Emitter<ForkRequest>;

  /** User message id → the latest agent message before it, where a fork keeps the history up to. */
  @memo((i) => [i.messages, i.forkable])
  get #forkPoints() {
    const points = new Map<string, string>();
    if (!this.forkable) return points;
    let messageId = '';
    for (const message of this.messages) {
      if (!('role' in message)) continue;
      if (message.role === 'agent' && message.messageId) messageId = message.messageId;
      if (message.role === 'user' && messageId) points.set(message.id, messageId);
    }
    return points;
  }

  // User messages are not selectable: long press opens their callout menu instead.
  #renderMarkdown = (text: string, streamKey = '', streaming = false, user = false) => html`
    <deck-stream-markdown
      class=${user ? '' : 'select-text'}
      .text=${text}
      .streamKey=${streamKey}
      ?streaming=${streaming}
      ?user=${user}
      cwd=${this.cwd}
      @click=${(event: MouseEvent) => openMessageLink(event, this.cwd)}
    ></deck-stream-markdown>
  `;

  #copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      Toast.open('success', i18n.get('global.copied'));
    } catch {
      Toast.open('error', i18n.get('global.copyFailed'));
    }
  };

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

  // A widget's choices answer the reply it sits in; once the user has sent another message, they are out of context.
  #onWidgetSend = (event: Event, messageId: string) => {
    const lastUserIndex = this.messages.findLastIndex((message) => 'role' in message && message.role === 'user');
    if (lastUserIndex < this.messages.findIndex(({ id }) => id === messageId)) return;
    event.stopPropagation();
    Toast.open('warning', i18n.get('widget.stale'));
  };

  #renderTextMessage = (message: TextMessage) => {
    const { attachments: linked, markdown } = extractMessageAttachments(
      message.role === 'user' ? stripVoiceChatMarker(message.text) : message.text,
      i18n.get('attachment.imageDefaultName'),
    );
    const attachments = [...(message.attachments ?? []), ...linked];

    if (message.role === 'user') {
      const forkPoint = this.#forkPoints.get(message.id);
      const menu: CalloutItem[] = [];
      if (markdown.trim()) menu.push({ label: i18n.get('global.copy'), handle: () => this.#copy(markdown) });
      if (forkPoint) {
        menu.push({
          label: i18n.get('timeline.fork'),
          handle: () => this.fork({ messageId: forkPoint, text: markdown, attachments }),
        });
      }
      return html`
        <div class="mt-8 mb-4 flex justify-end first:mt-0">
          <tap-callout
            class="max-w-[min(86%,560px)]"
            @show=${() => hapticImpact('medium')}
            .menu=${menu}
          >
            <div class="flex flex-col items-end">
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
          </tap-callout>
        </div>
      `;
    }

    return html`
      <article
        @pointerdown=${this.#setSelectionMenu}
        @widget-send=${(event: Event) => this.#onWidgetSend(event, message.id)}
        class="mb-4 min-w-0 text-base leading-[1.68] text-text">
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

  #renderElicitation = (elicitation: Elicitation) => html`
    <deck-elicitation
      class="mb-4"
      .elicitation=${elicitation}
      @respond=${(event: CustomEvent<ElicitationResponse>) => answerElicitation(elicitation.request, event.detail)}
    ></deck-elicitation>
  `;

  #setSelectionMenu = () => {
    const selection = window.getSelection();
    const ele = selection?.anchorNode?.parentElement;
    if (!ele || !selection.toString().trim()) return;
    // Only replies: user messages render with `user`, process details live in sheets outside the timeline.
    const markdown = closestElement(ele, DeckStreamMarkdownElement);
    if (!markdown || markdown.user || !this.contains(markdown)) return;
    setSelectionMenuItems({ items: [{ label: i18n.get('timeline.quote'), onClick: ({ text }) => this.quote(text) }] });
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
      this.elicitations,
    );
    const last = timelineItems.at(-1);

    return html`
      ${repeat(
        timelineItems,
        (item) =>
          item.type === 'group'
            ? item.group.id
            : item.type === 'elicitation'
              ? item.elicitation.request.requestId
              : item.message.id,
        (item) =>
          item.type === 'group'
            ? this.#renderProcessGroup(item.group)
            : item.type === 'elicitation'
              ? this.#renderElicitation(item.elicitation)
              : this.#renderTextMessage(item.message),
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
