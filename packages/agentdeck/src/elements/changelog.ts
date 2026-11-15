import { i18n } from '../i18n';
import { agentDeckTheme } from '../styles/theme';

/** Release notes from `distribution/whatsnew` by store language, newest first; inlined by `rsbuild.config.ts`. */
declare const __CHANGELOG__: Record<string, { version?: string; text: string }[]>;

const style = css`
  :scope {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 4px;
    color: ${agentDeckTheme.textColor};
  }
  section {
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.lightBackgroundColor};
  }
  h3 {
    font-size: ${agentDeckTheme.fontSizeSm};
    font-weight: 600;
  }
  p {
    line-height: 1.6;
    white-space: pre-line;
  }
`;

/** Content of the "Release notes" sheet in More settings. */
@customElement('deck-changelog')
@adoptedStyle(style)
export class DeckChangelogElement extends GemElement {
  @template()
  #render = () => {
    const entries = __CHANGELOG__[i18n.currentLanguage.startsWith('zh') ? 'zh-CN' : 'en-US'] ?? [];
    return html`${entries.map(
      ({ version, text }) => html`
        <section class="px-4 py-3">
          <h3 class="mb-1.5">${version ?? i18n.get('settings.changelogLatest')}</h3>
          <p>${text}</p>
        </section>
      `,
    )}`;
  };
}
