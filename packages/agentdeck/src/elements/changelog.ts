import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { agentDeckTheme, sheetPageStyle } from '../styles/theme';

/** Release notes from `distribution/whatsnew` by store language, newest first; inlined by `rsbuild.config.ts`. */
declare const __CHANGELOG__: Record<string, { version?: string; text: string }[]>;

const style = css`
  .page-content {
    gap: 12px;
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

/** Content of the "Release notes" page in More settings. */
@customElement('deck-changelog')
@adoptedStyle(blockContainer)
@adoptedStyle(sheetPageStyle)
@adoptedStyle(style)
export class DeckChangelogElement extends GemElement {
  @template()
  #render = () => {
    const entries = __CHANGELOG__[i18n.currentLanguage.startsWith('zh') ? 'zh-CN' : 'en-US'] ?? [];
    return html`
      <tap-page>
        <tap-navbar slot="header" title=${i18n.get('settings.changelog')} back default-back></tap-navbar>
        <div class="page-content">
          ${entries.map(
            ({ version, text }) => html`
              <section class="px-4 py-3">
                <h3 class="mb-1.5">${version ?? i18n.get('settings.changelogLatest')}</h3>
                <p>${text}</p>
              </section>
            `,
          )}
        </div>
      </tap-page>
    `;
  };
}
