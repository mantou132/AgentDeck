import { Sheet } from '@mantou/tap-ui/elements/sheet';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { ConfigChoice } from 'src/agent/api';
import { i18n } from 'src/i18n';
import { hapticSelection } from 'src/lib/haptics';
import { type ConfigSelect, getConfigSelects, isModelSelect } from 'src/session/config-options';
import { changeSessionConfig } from 'src/state/config-options';
import { isSplitView } from 'src/state/layout';
import { getSession } from 'src/state/sessions';
import { getRuntime, sessionsStore } from 'src/state/store';
import { icons } from 'src/styles/icons';
import { agentDeckTheme, sheetCellGroupStyle, sheetPageStyle } from 'src/styles/theme';

const style = css`
  .choice-description {
    overflow: hidden;
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeSm};
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`;

/** Page for session config Sheet: root page (model radio + entries for other configs) when `configId` is omitted; otherwise a radio choice page for that config. */
@customElement('deck-session-config')
@adoptedStyle(blockContainer)
@adoptedStyle(sheetPageStyle)
@adoptedStyle(sheetCellGroupStyle)
@adoptedStyle(style)
@connectStore(sessionsStore)
export class DeckSessionConfigElement extends GemElement {
  @property sessionId = '';
  @attribute configId: string;

  get #selects() {
    return getConfigSelects(getRuntime(this.sessionId).options);
  }

  #change = (select: ConfigSelect, value: string) => {
    const session = getSession(this.sessionId);
    if (!session) return;
    hapticSelection();
    changeSessionConfig(session, select.id, value);
  };

  #open = (select: ConfigSelect) => {
    Stack.getClosestStack(this)?.push({
      content: html`<deck-session-config .sessionId=${this.sessionId} config-id=${select.id}></deck-session-config>`,
    });
  };

  /** Some agents prefix descriptions with "<name> · ", which is redundant with the preceding line */
  #description = ({ name, description }: ConfigChoice) =>
    description?.startsWith(`${name} · `) ? description.slice(name.length + 3) : description;

  #renderChoices = (select: ConfigSelect) => html`
    <tap-cell-group
      class="choices"
      aria-label=${select.name}
      .items=${select.choices.map((choice) => {
        const checked = choice.value === select.currentValue;
        return {
          label: html`
            <div>${choice.name}</div>
            <div v-if=${!!choice.description} class="choice-description">${this.#description(choice)}</div>
          `,
          action: false,
          extra: checked ? html`<tap-use class="check" .element=${icons.check}></tap-use>` : undefined,
          onClick: () => !checked && this.#change(select, choice.value),
        };
      })}
    ></tap-cell-group>
  `;

  @template()
  #render = () => {
    const selects = this.#selects;
    const current = this.configId ? selects.find((select) => select.id === this.configId) : undefined;
    const model = this.configId ? undefined : selects.find(isModelSelect);
    const others = selects.filter((select) => select !== model);
    return html`
      <tap-page>
        <tap-navbar
          slot="header"
          title=${current?.name ?? (model ? i18n.get('composer.selectModel') : i18n.get('composer.configHeading'))}
          ?back=${!!this.configId}
          ?default-back=${!!this.configId}
        ></tap-navbar>
        <div class="page-content">
          ${
            current
              ? this.#renderChoices(current)
              : html`
                  ${model ? this.#renderChoices(model) : ''}
                  <tap-cell-group
                    v-if=${!!others.length}
                    .items=${others.map((select) => ({
                      label: select.name,
                      description: select.choices.find((choice) => choice.value === select.currentValue)?.name,
                      onClick: () => this.#open(select),
                    }))}
                  ></tap-cell-group>
                `
          }
        </div>
      </tap-page>
    `;
  };
}

export const openSessionConfig = (sessionId: string) =>
  Sheet.open({
    maskClosable: true,
    hasStack: true,
    snap: !isSplitView(),
    body: html`<deck-session-config .sessionId=${sessionId}></deck-session-config>`,
  });
