import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { type AppLanguage, langNames } from '../config';
import { i18n } from '../i18n';
import { hapticSelection } from '../lib/haptics';
import { setLanguage } from '../state/app';
import { agentdeckStore } from '../state/store';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :scope {
    color: ${agentDeckTheme.textColor};
    font-family: ${agentDeckTheme.font};
  }
  tap-page, tap-navbar {
    background: ${agentDeckTheme.backgroundColor};
  }
  tap-navbar {
    border: 0;
    margin-inline: 10px;
  }
  .page-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 10px 20px calc(20px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
  .page-content > tap-cell-group {
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
  .choices tap-cell {
    padding-block: 8px;
    line-height: 1.3;
  }
  .check {
    display: block;
    width: 1.25em;
    color: ${agentDeckTheme.primaryColor};
  }
`;

/** Language selection page in More settings sheet. */
@customElement('deck-language-settings')
@adoptedStyle(blockContainer)
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class DeckLanguageSettingsElement extends GemElement {
  #change = async (value: AppLanguage) => {
    if (value === agentdeckStore.language) return;
    hapticSelection();
    await setLanguage(value);
  };

  @template()
  #render = () => {
    const current = agentdeckStore.language;
    const items: { label: string; value: AppLanguage }[] = [
      { label: i18n.get('settings.languageSystem'), value: '' },
      ...Object.entries(langNames).map(([value, label]) => ({ label, value: value as AppLanguage })),
    ];

    return html`
      <tap-page>
        <tap-navbar slot="header" title=${i18n.get('settings.language')} back default-back></tap-navbar>
        <div class="page-content">
          <tap-cell-group
            class="choices"
            aria-label=${i18n.get('settings.language')}
            footer=${i18n.get('settings.languageDesc')}
            .items=${items.map(({ label, value }) => {
              const checked = current === value;
              return {
                label,
                action: false,
                extra: checked ? html`<tap-use class="check" .element=${icons.check}></tap-use>` : undefined,
                onClick: () => !checked && this.#change(value),
              };
            })}
          ></tap-cell-group>
        </div>
      </tap-page>
    `;
  };
}
