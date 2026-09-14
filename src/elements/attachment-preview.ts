import { i18n } from '../i18n';
import { getCodeLang, isSmallTextFile } from '../lib/file-preview';
import type { Attachment } from '../session/types';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :scope {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .header {
    text-align: center;
    padding-top: 6px;
  }
  .title {
    margin: 0;
    word-break: break-word;
    font-family: ${agentDeckTheme.displayFont};
    font-size: 1.125rem;
    line-height: 1.375;
    font-weight: 600;
    letter-spacing: -0.025em;
    color: ${agentDeckTheme.highlightColor};
  }
  .description {
    margin: 6px 0 0;
    font-family: ${agentDeckTheme.font};
    font-size: 0.875rem;
    line-height: 1.5;
    font-weight: 400;
    color: ${agentDeckTheme.describeColor};
  }
  .image {
    display: block;
    margin-inline: auto;
    max-height: 65dvh;
    max-width: 100%;
    border-radius: ${agentDeckTheme.normalRound};
    object-fit: contain;
  }
  .code-block {
    display: block;
    margin: 0;
    max-height: 65dvh;
    overflow: auto;
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.backgroundColor};
  }
  .plain-text {
    margin: 0;
    max-height: 65dvh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.backgroundColor};
    padding: 1rem;
    font-family: ${agentDeckTheme.codeFont};
    font-size: 0.875rem;
    line-height: 1.625;
    color: ${agentDeckTheme.textColor};
  }
`;

@customElement('deck-attachment-preview')
@adoptedStyle(style)
export class DeckAttachmentPreviewElement extends GemElement {
  @property attachment?: Attachment | null;

  @template()
  #render = () => {
    const attachment = this.attachment;
    if (!attachment) return null;

    const isImage = attachment.kind === 'image';
    const text = attachment.kind === 'text' ? attachment.text : '';
    const isSmall = isSmallTextFile(text);
    const lang = attachment.name ? getCodeLang(attachment.name) : '';
    const heading = attachment.name || i18n.get('attachment.previewHeading');
    const description = isImage ? i18n.get('attachment.imageDesc') : i18n.get('attachment.textDesc');

    return html`
      <div class="header">
        <h2 class="title">${heading}</h2>
        <p v-if=${!!description} class="description">${description}</p>
      </div>
      ${
        isImage
          ? html`<img class="image" src=${attachment.previewUrl} alt=${attachment.name || ''} />`
          : isSmall
            ? html`<tap-code-block codelang=${lang} class="code-block">${text}</tap-code-block>`
            : html`<pre class="plain-text">${text}</pre>`
      }
    `;
  };
}
