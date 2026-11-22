import { ActionSheet } from '@mantou/tap-ui/elements/action-sheet';
import { Sheet } from '@mantou/tap-ui/elements/sheet';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { type AppLanguage, DISPLAY_SKILLS, langNames, SKILL_REQUIRES, WORKFLOW_SKILLS } from '../config';
import { i18n, type LocaleKey } from '../i18n';
import { setLanguage, setSkillEnabled } from '../state/app';
import {
  type AppManifest,
  openSavedApp,
  pinSavedApp,
  pinSupported,
  removeSavedApp,
  savedAppIconUrl,
  savedAppsStore,
} from '../state/saved-apps';
import { agentdeckStore, isSkillEnabled, isSkillRestricted } from '../state/store';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :scope {
    display: block;
    padding-top: 4px;
    color: ${agentDeckTheme.textColor};
  }
  tap-cell {
    padding-block: 8px;
    line-height: 1.3;
    background: ${agentDeckTheme.lightBackgroundColor};
  }
  /* Round the rows, not the group, which also holds the heading and footer */
  tap-cell:first-of-type {
    border-start-start-radius: ${agentDeckTheme.normalRound};
    border-start-end-radius: ${agentDeckTheme.normalRound};
  }
  tap-cell:last-of-type {
    border-end-start-radius: ${agentDeckTheme.normalRound};
    border-end-end-radius: ${agentDeckTheme.normalRound};
  }
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
@adoptedStyle(style)
@connectStore(agentdeckStore)
@connectStore(savedAppsStore)
export class DeckMoreSettingsElement extends GemElement {
  #state = createState({ version: '' });

  @mounted()
  #readVersion = async () => {
    if (isTauri()) this.#state({ version: await getVersion() });
  };

  #selectLanguage = async () => {
    const action = await ActionSheet.open<AppLanguage>({
      title: i18n.get('settings.language'),
      actions: [
        { label: i18n.get('settings.languageSystem'), value: '' },
        ...Object.entries(langNames).map(([value, label]) => ({ label, value: value as AppLanguage })),
      ],
      cancelText: i18n.get('global.cancel'),
    });
    if (!action || action.value === undefined) return;
    await setLanguage(action.value);
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

  @template()
  #render = () => html`
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
          onClick: this.#selectLanguage,
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
          onClick: () =>
            Sheet.open({
              maskClosable: true,
              header: i18n.get('settings.changelog'),
              body: html`<deck-changelog></deck-changelog>`,
            }),
        },
      ]}
    ></tap-cell-group>
  `;
}
