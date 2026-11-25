import { ActionSheet } from '@mantou/tap-ui/elements/action-sheet';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { DISPLAY_SKILLS, langNames, SKILL_REQUIRES, WORKFLOW_SKILLS } from 'src/config';
import { i18n, type LocaleKey } from 'src/i18n';
import { setSkillEnabled } from 'src/state/app';
import {
  type AppManifest,
  openSavedApp,
  pinSavedApp,
  pinSupported,
  removeSavedApp,
  savedAppIconUrl,
  savedAppsStore,
} from 'src/state/saved-apps';
import { agentdeckStore, isSkillEnabled, isSkillRestricted } from 'src/state/store';
import { agentDeckTheme, sheetCellGroupStyle, sheetPageStyle } from 'src/styles/theme';

const style = css`
  .app {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .app img {
    width: 2rem;
    height: 2rem;
    border-radius: 22%;
  }
  .description {
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeSm};
  }
`;

/** Content of the settings page's "More settings" sheet, one cell group per section. */
@customElement('deck-more-settings')
@adoptedStyle(blockContainer)
@adoptedStyle(sheetPageStyle)
@adoptedStyle(sheetCellGroupStyle)
@adoptedStyle(style)
@connectStore(agentdeckStore)
@connectStore(savedAppsStore)
export class DeckMoreSettingsElement extends GemElement {
  #state = createState({ version: '' });

  @mounted()
  #readVersion = async () => {
    if (isTauri()) this.#state({ version: await getVersion() });
  };

  #openLanguage = () => {
    Stack.getClosestStack(this)?.push({
      content: html`<deck-language-settings></deck-language-settings>`,
    });
  };

  #manageApp = async ({ id, name }: AppManifest) => {
    const action = await ActionSheet.open({
      title: name,
      actions: [
        { label: i18n.get('app.open'), value: 'open' },
        ...(pinSupported ? [{ label: i18n.get('app.pin'), value: 'pin' }] : []),
        { label: i18n.get('app.remove'), value: 'remove', danger: true },
      ],
      cancelText: i18n.get('global.cancel'),
    });
    try {
      if (action?.value === 'open') await openSavedApp(id);
      if (action?.value === 'pin') await pinSavedApp({ id, name });
      if (action?.value === 'remove') await removeSavedApp(id);
    } catch (error) {
      Toast.open('error', error instanceof Error ? error.message : String(error));
    }
  };

  #skillItem = (skill: string) => {
    const required = SKILL_REQUIRES[skill];
    // The toggle is kept for hosts that offer it.
    const restricted = isSkillRestricted(skill) || (!!required && isSkillRestricted(required));
    return {
      label: html`
        <div>${i18n.get(`skill.${skill}` as LocaleKey)}</div>
        <div class="description">
          ${restricted ? i18n.get('settings.skillRestricted') : i18n.get(`skill.${skill}Desc` as LocaleKey)}
        </div>
      `,
      action: false,
      // Not the group's own switch rows, which cannot be disabled while the required skill is off.
      extra: html`
        <tap-switch
          aria-label=${i18n.get(`skill.${skill}` as LocaleKey)}
          ?checked=${!restricted && isSkillEnabled(skill)}
          ?disabled=${restricted || (!!required && !isSkillEnabled(required))}
          @change=${(event: CustomEvent<boolean>) => setSkillEnabled(skill, event.detail)}
        ></tap-switch>
      `,
    };
  };

  #openChangelog = () => {
    Stack.getClosestStack(this)?.push({
      content: html`<deck-changelog></deck-changelog>`,
    });
  };

  @template()
  #render = () => html`
    <tap-page>
      <tap-navbar slot="header" title=${i18n.get('settings.moreSettings')}></tap-navbar>
      <div class="page-content">
        <tap-cell-group
          v-if=${savedAppsStore.apps.length > 0}
          heading=${i18n.get('settings.savedAppsTitle')}
          footer=${i18n.get(pinSupported ? 'settings.savedAppsDesc' : 'settings.savedAppsWidgetDesc')}
          .items=${savedAppsStore.apps.map((app) => ({
            label: html`<div class="app"><img alt="" src=${savedAppIconUrl(app.id)} /><span>${app.name}</span></div>`,
            onClick: () => this.#manageApp(app),
          }))}
        ></tap-cell-group>
        <tap-cell-group
          footer=${i18n.get('settings.languageDesc')}
          .items=${[
            {
              label: i18n.get('settings.language'),
              extra: agentdeckStore.language ? langNames[agentdeckStore.language] : i18n.get('settings.languageSystem'),
              onClick: this.#openLanguage,
            },
          ]}
        ></tap-cell-group>
        <tap-cell-group
          heading=${i18n.get('settings.workflowSkillsTitle')}
          footer=${i18n.get('settings.workflowSkillsDesc')}
          .items=${WORKFLOW_SKILLS.map(this.#skillItem)}
        ></tap-cell-group>
        <tap-cell-group
          heading=${i18n.get('settings.displaySkillsTitle')}
          footer=${i18n.get('settings.skillsDesc')}
          .items=${DISPLAY_SKILLS.map(this.#skillItem)}
        ></tap-cell-group>
        <tap-cell-group
          .items=${[
            {
              label: i18n.get('settings.changelog'),
              extra: this.#state.version,
              onClick: this.#openChangelog,
            },
          ]}
        ></tap-cell-group>
      </div>
    </tap-page>
  `;
}
