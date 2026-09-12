import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { toolCallDiffs } from '../lib/diff';
import { followBottom } from '../lib/follow-bottom';
import { diffColorScheme, markdownExtensions, markdownStyle } from '../lib/markdown';
import { openMessageLink } from '../navigation';
import { getToolCommand, getToolTitle, groupTimelineMessages, type ProcessGroup } from '../session/timeline';
import { getSession } from '../state/sessions';
import { agentdeckStore } from '../state/store';
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
  gem-bind-marked {
    color: ${agentDeckTheme.textColor};
    font-size: 1rem;
    line-height: 1.625;
  }
  .diffs { overflow-x: auto; }
  gem-bind-diff2html {
    position: relative;
    box-sizing: border-box;
    display: block;
    width: 100%;
    overflow-x: auto;
    border-radius: ${agentDeckTheme.normalRound};
  }
  .input-label {
    margin: 0 0 0.5rem;
    color: ${agentDeckTheme.describeColor};
    font-size: 0.75rem;
    line-height: 1rem;
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
  .input-params {
    overflow-x: auto;
    border-radius: ${agentDeckTheme.normalRound};
    padding: 0.875rem;
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

  @effect((i) => [i.sessionId, i.groupId, i.itemId, i.#pageRef.value, i.#contentRef.value])
  #followContent = () =>
    followBottom(this.#pageRef.value?.shadowRoot?.querySelector<HTMLElement>('[part=main]'), this.#contentRef.value)
      ?.disconnect;

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

  #openLink = (event: MouseEvent) => {
    if (openMessageLink(event, getSession(this.sessionId)?.cwd || '')) this.navigate();
  };

  #renderContent = () => {
    const item = this.#item;
    if (!item) return html``;
    if (item.type === 'thought') {
      return html`
        <gem-bind-marked
          ?streaming=${this.#group?.pending && item.pending}
          .mdStyle=${markdownStyle}
          .extensions=${markdownExtensions}
          @click=${this.#openLink}
        >${item.text}</gem-bind-marked>
      `;
    }
    const diffs = toolCallDiffs(item.data.content);
    return html`
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
      <div v-if=${!diffs.length && item.data.rawInput !== undefined}>
        <p class="input-label">${i18n.get('timeline.inputParams')}</p>
        <pre class="input-params">${JSON.stringify(item.data.rawInput, null, 2)}</pre>
      </div>
      <pre v-if=${!diffs.length && item.data.rawInput === undefined}>${getToolCommand(item.data)}</pre>
    `;
  };

  @template()
  #render = () => {
    const item = this.#item;
    const title = item?.type === 'tool' ? getToolTitle(item.data) : i18n.get('timeline.thought');
    return html`
      <tap-page ${this.#pageRef}>
        <tap-navbar slot="header" title=${title} back default-back></tap-navbar>
        <div ${this.#contentRef} class="page-content">${this.#renderContent()}</div>
      </tap-page>
    `;
  };
}
