import { i18n } from '../i18n';
import { isAbsoluteHostPath, previewSupported } from '../lib/preview';
import { openPreview } from '../navigation';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :host {
    display: block;
    box-sizing: border-box;
    overflow: hidden;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .card:disabled {
    cursor: default;
  }
  tap-use {
    flex-shrink: 0;
    width: 1.5rem;
    color: ${agentDeckTheme.primaryColor};
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    color: ${agentDeckTheme.highlightColor};
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir {
    color: ${agentDeckTheme.describeColor};
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
    overflow-wrap: anywhere;
  }
  .open {
    flex-shrink: 0;
    color: ${agentDeckTheme.primaryStrongColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
  }
`;

/** Body of an `agentdeck-preview` fenced block: the entry HTML path, as taught by the host's preview skill. */
@customElement('deck-preview')
@adoptedStyle(style)
@shadow()
export class DeckPreviewElement extends GemElement {
  @attribute path: string;

  @template()
  #render = () => {
    const path = this.path.trim();
    const slash = path.search(/[\\/][^\\/]*$/);
    const openable = previewSupported && isAbsoluteHostPath(path);
    return html`
      <button class="card" type="button" ?disabled=${!openable} @click=${() => openPreview(path)}>
        <tap-use .element=${icons.code}></tap-use>
        <div class="text">
          <div class="name">${path.slice(slash + 1)}</div>
          <div class="dir">${path.slice(0, slash + 1)}</div>
        </div>
        <span v-if=${openable} class="open">${i18n.get('preview.open')}</span>
      </button>
    `;
  };
}
