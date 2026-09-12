import type { Emitter } from '@mantou/gem/lib/decorators';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { getToolStatus, getToolTitle, groupTimelineMessages, type ProcessGroup } from '../session/timeline';
import { agentdeckStore } from '../state/store';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :scope {
    color: ${agentDeckTheme.textColor};
    font-family: ${agentDeckTheme.font};
    line-height: 1.5;
  }
  tap-page, tap-navbar { background: ${agentDeckTheme.lightBackgroundColor}; }
  tap-navbar { border: 0; }
  .page-content {
    padding: 0 20px calc(20px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
  .empty {
    padding: 2.5rem 0;
    color: ${agentDeckTheme.describeColor};
    font-size: 0.875rem;
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
    user-select: none;
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
    font-size: 0.875rem;
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
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class DeckProcessDetailElement extends GemElement {
  @property sessionId = '';
  @property groupId = '';
  @emitter navigate: Emitter;

  @memo((i) => [
    i.sessionId,
    i.groupId,
    agentdeckStore.messagesBySession[i.sessionId],
    agentdeckStore.pendingSessionIds.includes(i.sessionId),
  ])
  get #group() {
    return groupTimelineMessages(
      agentdeckStore.messagesBySession[this.sessionId] ?? [],
      agentdeckStore.pendingSessionIds.includes(this.sessionId),
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
    <tap-page>
      <tap-navbar slot="header" title=${i18n.get('timeline.processSummary')}></tap-navbar>
      <div class="page-content">${this.#renderList()}</div>
    </tap-page>
  `;
}
