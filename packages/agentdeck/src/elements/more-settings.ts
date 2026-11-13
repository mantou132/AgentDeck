import { SKILL_REQUIRES, SUPPORTED_SKILLS } from '../config';
import { i18n, type LocaleKey } from '../i18n';
import { setSkillEnabled } from '../state/app';
import { agentdeckStore, isSkillEnabled } from '../state/store';
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
  .description {
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeSm};
  }
`;

/** Content of the settings page's "More settings" sheet, one cell group per section. */
@customElement('deck-more-settings')
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class DeckMoreSettingsElement extends GemElement {
  @template()
  #render = () => html`
    <tap-cell-group
      heading=${i18n.get('settings.skillsTitle')}
      footer=${i18n.get('settings.skillsDesc')}
      .items=${SUPPORTED_SKILLS.map((skill) => {
        const required = SKILL_REQUIRES[skill];
        return {
          label: html`
            <div>${i18n.get(`skill.${skill}` as LocaleKey)}</div>
            <div class="description">${i18n.get(`skill.${skill}Desc` as LocaleKey)}</div>
          `,
          action: false,
          // Not the group's own switch rows, which cannot be disabled while the required skill is off.
          extra: html`
            <tap-switch
              ?checked=${isSkillEnabled(skill)}
              ?disabled=${!!required && !isSkillEnabled(required)}
              @change=${(event: CustomEvent<boolean>) => setSkillEnabled(skill, event.detail)}
            ></tap-switch>
          `,
        };
      })}
    ></tap-cell-group>
  `;
}
