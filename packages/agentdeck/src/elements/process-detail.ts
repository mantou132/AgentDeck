import type { Emitter } from '@mantou/gem/lib/decorators';
import type { TapPageElement } from '@mantou/tap-ui/elements/page';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from 'src/i18n';
import { followBottom } from 'src/lib/follow-bottom';
import { hasActiveStream } from 'src/lib/stream-text';
import { getToolStatus, getToolTitle, groupTimelineMessages, type ProcessGroup } from 'src/session/timeline';
import { getMessages, getRuntime, isTurnRunning, messagesStore, sessionsStore } from 'src/state/store';
import { icons } from 'src/styles/icons';
import { agentDeckTheme, sheetPageStyle } from 'src/styles/theme';

const style = css`
  .empty {
    padding: 2.5rem 0;
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeSm};
    text-align: center;
  }
  .process-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .process-item {
    position: relative;
    display: flex;
    gap: 0.75rem;
  }
  .marker {
    display: flex;
    flex: 0 0 1.25rem;
    flex-direction: column;
    align-items: center;
  }
  .status-icon {
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    margin-top: 0.125rem;
    color: ${agentDeckTheme.describeColor};
  }
  .status-icon.pending { color: ${agentDeckTheme.primaryStrongColor}; }
  .status-icon.failed { color: ${agentDeckTheme.negativeColor}; }
  .connector {
    flex: 1;
    width: 1px;
    margin: 0.5rem 0;
    background: ${agentDeckTheme.borderColor};
  }
  .step-content {
    flex: 1;
    min-width: 0;
    padding-bottom: 1.5rem;
  }
  .step-button {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    border: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    outline: none;
    cursor: pointer;
  }
  .step-button::after {
    position: absolute;
    inset: 0;
    content: '';
  }
  .step-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: ${agentDeckTheme.fontSizeSm};
    font-weight: 500;
    line-height: 1.25rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chevron {
    flex-shrink: 0;
    width: 0.875rem;
    height: 0.875rem;
    margin-top: 0.25rem;
    color: ${agentDeckTheme.disabledColor};
  }
`;

@customElement('deck-process-detail')
@adoptedStyle(blockContainer)
@adoptedStyle(sheetPageStyle)
@adoptedStyle(style)
@connectStore(sessionsStore)
@connectStore(messagesStore)
export class DeckProcessDetailElement extends GemElement {
  @property sessionId = '';
  @property groupId = '';
  @emitter navigate: Emitter;

  #pageRef = createRef<TapPageElement>();
  #contentRef = createRef<HTMLElement>();

  @effect((i) => [i.sessionId, i.groupId, i.#pageRef.value, i.#contentRef.value])
  #followContent = () =>
    followBottom(this.#pageRef.value?.scrollElement, this.#contentRef.value, {
      isActive: () => Boolean(this.#group?.pending || hasActiveStream(`${this.sessionId}:${this.groupId}`)),
    })?.disconnect;

  @memo((i) => [
    i.sessionId,
    i.groupId,
    getMessages(i.sessionId),
    isTurnRunning(i.sessionId),
    getRuntime(i.sessionId).elicitations,
  ])
  get #group() {
    return groupTimelineMessages(
      getMessages(this.sessionId),
      isTurnRunning(this.sessionId),
      getRuntime(this.sessionId).elicitations,
    ).find(
      (item): item is { type: 'group'; group: ProcessGroup } => item.type === 'group' && item.group.id === this.groupId,
    )?.group;
  }

  #openStep = (item: ProcessGroup['items'][number]) => {
    Stack.getClosestStack(this)?.push({
      content: html`
        <deck-process-step
          .sessionId=${this.sessionId}
          .groupId=${this.groupId}
          .itemId=${item.id}
          @navigate=${() => this.navigate()}
        ></deck-process-step>
      `,
    });
  };

  #renderList = () => {
    const group = this.#group;
    if (!group?.items.length) {
      return html`<div class="empty">${i18n.get('timeline.noProcess')}</div>`;
    }

    return html`
      <ol class="process-list">
        ${group.items.map((item, index) => {
          const isThought = item.type === 'thought';
          const status = isThought
            ? group.pending && item.pending
              ? 'in_progress'
              : 'completed'
            : getToolStatus(item.data, group.pending);
          const isPending = status === 'pending' || status === 'in_progress';
          return html`
            <li class="process-item">
              <div class="marker">
                <tap-use
                  class=${classMap({
                    'status-icon': true,
                    pending: isPending,
                    failed: status === 'failed',
                  })}
                  .element=${isPending ? icons.loading : status === 'failed' ? icons.error : isThought ? icons.sparkles : icons.terminal}
                ></tap-use>
                <span v-if=${index < group.items.length - 1} class="connector"></span>
              </div>
              <div class="step-content">
                <button
                  type="button"
                  class="step-button"
                  @click=${() => this.#openStep(item)}
                >
                  <span class="step-title">${isThought ? i18n.get('timeline.thought') : getToolTitle(item.data)}</span>
                  <tap-use class="chevron" .element=${icons.right}></tap-use>
                </button>
              </div>
            </li>
          `;
        })}
      </ol>
    `;
  };

  @template()
  #render = () => html`
    <tap-page ${this.#pageRef}>
      <tap-navbar slot="header" title=${i18n.get('timeline.processSummary')}></tap-navbar>
      <div ${this.#contentRef} class="page-content">${this.#renderList()}</div>
    </tap-page>
  `;
}
