import { Toast } from '@mantou/tap-ui/elements/toast';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { isAbsoluteHostPath, previewSupported, toPreviewUrl } from '../lib/preview';
import { openPreview } from '../navigation';
import {
  type AppManifest,
  pinSavedApp,
  pinSupported,
  readAppManifest,
  saveApp,
  savedAppsSupported,
} from '../state/saved-apps';
import { hostHome } from '../state/store';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :host {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    box-sizing: border-box;
    padding: 0.75rem;
    overflow: hidden;
  }
  .icon {
    flex-shrink: 0;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 22%;
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
    overflow: hidden;
    color: ${agentDeckTheme.describeColor};
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button {
    flex-shrink: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: ${agentDeckTheme.primaryStrongColor};
    font: inherit;
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

/** Body of an `agentdeck-app` fenced block: the `index.html` of an app built with the host's `app` skill. */
@customElement('deck-app')
@adoptedStyle(style)
@shadow()
export class DeckAppElement extends GemElement {
  @attribute path: string;

  #state = createState({ manifest: undefined as AppManifest | undefined, iconFailed: false, saving: false });

  get #entry() {
    return this.path.trim();
  }

  get #dir() {
    return this.#entry.replace(/[\\/][^\\/]*$/, '');
  }

  get #usable() {
    return previewSupported && isAbsoluteHostPath(this.#entry);
  }

  // Shows the app's own name; the directory name stands in when the host can't be read.
  @effect((i) => [i.path])
  #readManifest = async () => {
    if (!this.#usable) return;
    try {
      this.#state({ manifest: await readAppManifest(this.#entry) });
    } catch (error) {
      console.warn('App manifest unavailable:', this.#entry, error);
    }
  };

  // Saves over an earlier copy too. Android then asks the launcher to pin it (the launcher keeps one per app); iOS
  // can't add to the home screen, so it points to the widget.
  #addToHomeScreen = async () => {
    this.#state({ saving: true });
    const closeToast = Toast.open({ type: 'loading', content: i18n.get('app.saving'), duration: Infinity });
    try {
      const manifest = await saveApp(this.#entry);
      closeToast();
      if (pinSupported) {
        await pinSavedApp(manifest);
      } else {
        Toast.open('success', i18n.get('app.widgetHint'));
      }
    } catch (error) {
      closeToast();
      Toast.open('error', error instanceof Error ? error.message : String(error));
    } finally {
      this.#state({ saving: false });
    }
  };

  @template()
  #render = () => {
    const { manifest, iconFailed, saving } = this.#state;
    // `<app>/dist/index.html`
    const [dirName, parent] = this.#dir.split(/[\\/]/).reverse();
    return html`
      <img
        v-if=${this.#usable && !iconFailed}
        class="icon"
        alt=""
        src=${toPreviewUrl(`${this.#dir}/icon.svg`)}
        @error=${() => this.#state({ iconFailed: true })}
      />
      <tap-use v-else .element=${icons.code}></tap-use>
      <div class="text">
        <div class="name">${manifest?.name || (dirName === 'dist' ? parent : dirName)}</div>
        <div class="dir">${displayPath(this.#entry, hostHome())}</div>
      </div>
      <button type="button" ?disabled=${!this.#usable} @click=${() => openPreview(this.#entry, { headerless: true })}>
        ${i18n.get('app.preview')}
      </button>
      <button
        v-if=${savedAppsSupported}
        type="button"
        ?disabled=${!this.#usable || saving}
        @click=${this.#addToHomeScreen}
      >
        ${i18n.get('app.pin')}
      </button>
    `;
  };
}
