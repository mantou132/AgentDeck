import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { type AppLanguage, langNames } from 'src/config';
import { i18n } from 'src/i18n';
import { hapticSelection } from 'src/lib/haptics';
import { setLanguage } from 'src/state/app';
import { agentdeckStore } from 'src/state/store';
import { icons } from 'src/styles/icons';
import { sheetCellGroupStyle, sheetPageStyle } from 'src/styles/theme';

/** Language selection page in More settings sheet. */
@customElement('deck-language-settings')
@adoptedStyle(blockContainer)
@adoptedStyle(sheetPageStyle)
@adoptedStyle(sheetCellGroupStyle)
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
