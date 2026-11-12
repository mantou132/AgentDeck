import type { Emitter } from '@mantou/gem/lib/decorators';
import { Sheet } from '@mantou/tap-ui/elements/sheet';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { isSplitView } from '../state/layout';
import { sessionsStore } from '../state/store';
import { agentDeckTheme } from '../styles/theme';

/** `new` lets the user pick the new session's directory; `sessionId` is another session. */
export type SendTarget = 'current' | 'new' | { sessionId: string };

const style = css`
  :scope {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 4px 0 8px;
    color: ${agentDeckTheme.textColor};
    font-family: ${agentDeckTheme.font};
  }
  tap-cell-group {
    margin: 0;
    overflow: hidden;
    border-radius: ${agentDeckTheme.normalRound};
  }
  tap-cell-group tap-cell {
    background: ${agentDeckTheme.lightBackgroundColor};
    cursor: pointer;
    &:active {
      background: ${agentDeckTheme.hoverBackgroundColor};
    }
  }
  .line {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .path {
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeSm};
  }
`;

@customElement('deck-send-to')
@adoptedStyle(blockContainer)
@adoptedStyle(style)
@connectStore(sessionsStore)
export class DeckSendToElement extends GemElement {
  @property sessionId = '';
  @emitter pick: Emitter<SendTarget>;

  /** Sessions from the current session's group first, then the others in list order. */
  get #otherSessions() {
    const { sessionGroups } = sessionsStore;
    const current = sessionGroups.findIndex((group) =>
      group.sessions.some((session) => session.sessionId === this.sessionId),
    );
    const groups = current > 0 ? [sessionGroups[current], ...sessionGroups.toSpliced(current, 1)] : sessionGroups;
    return groups.flatMap((group) => group.sessions).filter((session) => session.sessionId !== this.sessionId);
  }

  @template()
  #render = () => {
    const others = this.#otherSessions;
    return html`
      <tap-cell-group
        .items=${[
          { label: i18n.get('sendTo.current'), onClick: () => this.pick('current') },
          { label: i18n.get('sendTo.new'), onClick: () => this.pick('new') },
        ]}
      ></tap-cell-group>
      <tap-cell-group
        v-if=${!!others.length}
        .items=${others.map((session) => ({
          label: html`
            <div class="line">${session.title || i18n.get('session.untitled')}</div>
            <div class="line path">${displayPath(session.cwd)}</div>
          `,
          onClick: () => this.pick({ sessionId: session.sessionId }),
        }))}
      ></tap-cell-group>
    `;
  };
}

/** Resolves with the picked target, or `null` when the Sheet is dismissed. */
export const pickSendTarget = (sessionId: string) =>
  new Promise<SendTarget | null>((resolve) => {
    const result = Sheet.open({
      maskClosable: true,
      header: i18n.get('sendTo.heading'),
      // Pulling up scales only the Stack beside the split view sidebar; fit the content instead
      snap: !isSplitView(),
      body: html`<deck-send-to
        .sessionId=${sessionId}
        @pick=${({ detail }: CustomEvent<SendTarget>) => {
          resolve(detail);
          result.sheet.close(null);
        }}
      ></deck-send-to>`,
    });
    result.finally(() => resolve(null));
  });
