import type { Emitter } from '@mantou/gem/lib/decorators';
import { TapPageElement } from '@mantou/tap-ui/elements/page';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { toolCallDiffs } from '../lib/diff';
import { followBottom } from '../lib/follow-bottom';
import { diffColorScheme, markdownStyle } from '../lib/markdown';
import { openMessageLink } from '../navigation';
import {
  getToolCommand,
  getToolStatus,
  getToolTitle,
  groupTimelineMessages,
  type ProcessGroup,
  parseToolOutputs,
} from '../session/timeline';
import { getSession } from '../state/sessions';
import { agentdeckStore } from '../state/store';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :scope {
    color: ${agentDeckTheme.textColor};
    font-family: ${agentDeckTheme.font};
    line-height: 1.5;
  }
  tap-page, tap-navbar {
    background: ${agentDeckTheme.lightBackgroundColor};
  }
  tap-navbar {
    border: 0;
    margin-inline: 10px;
  }
  .page-content {
    padding: 10px 20px calc(20px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
  deck-stream-markdown,
  gem-bind-marked {
    color: ${agentDeckTheme.textColor};
    font-size: 1rem;
    line-height: 1.625;
  }
  .step-sections {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .step-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  .section-label {
    margin: 0;
    color: ${agentDeckTheme.describeColor};
    font-size: 0.75rem;
    line-height: 1rem;
  }
  .diffs {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow-x: auto;
  }
  gem-bind-diff2html {
    position: relative;
    box-sizing: border-box;
    display: block;
    width: 100%;
    overflow-x: auto;
    border-radius: ${agentDeckTheme.normalRound};
  }
  pre {
    margin: 0;
    color: ${agentDeckTheme.textColor};
    font-family: ${agentDeckTheme.codeFont};
    font-size: 0.875rem;
    line-height: 1.625;
    overflow-wrap: break-word;
    white-space: pre-wrap;
  }
  .code-block {
    overflow-x: auto;
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.backgroundColor};
  }
  .command-text {
    margin: 0;
    padding: 0.75rem 1rem;
    color: ${agentDeckTheme.textColor};
    font-family: ${agentDeckTheme.codeFont};
    font-size: 0.875rem;
    line-height: 1.625;
    overflow-wrap: break-word;
    white-space: pre-wrap;
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.backgroundColor};
  }
`;

@customElement('deck-process-step')
@adoptedStyle(blockContainer)
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class DeckProcessStepElement extends GemElement {
  @property sessionId = '';
  @property groupId = '';
  @property itemId = '';
  @emitter navigate: Emitter;

  #pageRef = createRef<HTMLElement>();
  #contentRef = createRef<HTMLElement>();

  @effect((i) => [i.sessionId, i.groupId, i.itemId, i.#updating, i.#pageRef.value, i.#contentRef.value])
  #followContent = () =>
    followBottom(
      this.#pageRef.value?.shadowRoot?.querySelector<HTMLElement>(`[part=${TapPageElement.main}]`),
      this.#contentRef.value,
      { isActive: () => this.#updating },
    )?.disconnect;

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

  get #item() {
    return this.#group?.items.find((item) => item.id === this.itemId);
  }

  get #updating() {
    const item = this.#item;
    if (!this.#group?.pending || !item) return false;
    if (item.type === 'thought') return item.pending;
    const status = getToolStatus(item.data, true);
    return status === 'pending' || status === 'in_progress';
  }

  #openLink = (event: MouseEvent) => {
    if (openMessageLink(event, getSession(this.sessionId)?.cwd || '')) this.navigate();
  };

  #renderContent = () => {
    const item = this.#item;
    if (!item) return html``;
    if (item.type === 'thought') {
      return html`
        <deck-stream-markdown
          .text=${item.text}
          .streamKey=${`${this.sessionId}:${this.groupId}:${item.id}`}
          ?streaming=${Boolean(this.#group?.pending && item.pending)}
          .mdStyle=${markdownStyle}
          @click=${this.#openLink}
        ></deck-stream-markdown>
      `;
    }

    const diffs = toolCallDiffs(item.data.content);
    const outputs = parseToolOutputs(item.data);
    const hasInput = item.data.rawInput !== undefined;
    const hasOutput = Boolean(diffs.length || outputs.texts.length || outputs.raw !== undefined);

    if (!hasInput && !hasOutput) {
      return html`<pre>${getToolCommand(item.data)}</pre>`;
    }

    return html`
      <div class="step-sections">
        <div v-if=${hasInput || hasOutput} class="step-section">
          <p class="section-label">${i18n.get('timeline.inputParams')}</p>
          <tap-code-block
            v-if=${hasInput}
            codelang=${typeof item.data.rawInput === 'string' ? '' : 'json'}
            class="code-block"
          >${typeof item.data.rawInput === 'string' ? item.data.rawInput : JSON.stringify(item.data.rawInput, null, 2)}</tap-code-block>
          <pre v-if=${!hasInput && hasOutput} class="command-text">${getToolCommand(item.data)}</pre>
        </div>
        <div v-if=${hasOutput} class="step-section">
          <p class="section-label">${i18n.get('timeline.output')}</p>
          <div v-if=${diffs.length} class="diffs">
            ${diffs.map(
              ({ text }) => html`
                <gem-bind-diff2html
                  .colorScheme=${diffColorScheme}
                  no-header
                  compact-line-numbers
                >${text}</gem-bind-diff2html>
              `,
            )}
          </div>
          <deck-stream-markdown
            v-if=${outputs.texts.length}
            .text=${outputs.texts.join('\n\n')}
            .streamKey=${`${this.sessionId}:${this.groupId}:${item.id}:output`}
            ?streaming=${this.#updating}
            .mdStyle=${markdownStyle}
            @click=${this.#openLink}
          ></deck-stream-markdown>
          <tap-code-block
            v-if=${outputs.raw !== undefined}
            codelang="json"
            class="code-block"
          >${JSON.stringify(outputs.raw, null, 2)}</tap-code-block>
        </div>
      </div>
    `;
  };

  @template()
  #render = () => {
    const item = this.#item;
    const title = item?.type === 'tool' ? getToolTitle(item.data) : i18n.get('timeline.thought');
    return html`
      <tap-page ${this.#pageRef}>
        <tap-navbar slot="header" title=${title} back default-back></tap-navbar>
        <div ${this.#contentRef} class="page-content select-text">${this.#renderContent()}</div>
      </tap-page>
    `;
  };
}
