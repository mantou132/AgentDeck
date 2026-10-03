import type { TapCodeBlockElement } from '@mantou/tap-ui/elements/code-block';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { RemoteFile } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { getCodeLang, isSmallTextFile } from '../lib/file-preview';
import { fileViewerMarkdownStyle, unfoldedMarkdownExtensions } from '../lib/markdown';
import { openMessageLink, openSettings } from '../navigation';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :scope {
    height: 100%;
  }
  mark {
    background: ${agentDeckTheme.primarySoftColor};
    color: inherit;
    scroll-margin-inline-start: 1rem;
  }
  footer {
    height: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  }
`;

@customElement('deck-file-viewer')
@adoptedStyle(blockContainer)
@adoptedStyle(style)
export class DeckFileViewerElement extends GemElement {
  @property path = '';
  @property cwd = '';
  @property line?: number;

  #state = createState({
    file: undefined as RemoteFile | undefined,
    imageUrl: '',
    loading: true,
    error: '',
    revision: 0,
    source: false,
    entered: false,
  });
  #mainRef = createRef<HTMLElement>();
  #lineRef = createRef<HTMLElement>();
  #codeBlockRef = createRef<TapCodeBlockElement>();

  // Relative images resolve against the host file's directory.
  get #markdownExtensions() {
    return unfoldedMarkdownExtensions(this.#state.file?.path.replace(/[^\\/]+$/, ''));
  }

  @effect((i) => [i.path, i.cwd, i.#state.revision])
  #read = () => {
    let active = true;
    let imageUrl = '';
    this.#state({ file: undefined, imageUrl, loading: true, error: '', source: Boolean(this.line) });
    agentApi.readFile(this.path, this.cwd).then(
      (file) => {
        if (!active) return;
        if (file.type === 'image') imageUrl = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
        this.#state({ file, imageUrl, loading: false });
      },
      (error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        this.#state({ loading: false, error: message });
      },
    );
    return () => {
      active = false;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  };

  @effect((i) => [i.line])
  #watchLine = () => {
    if (this.line && !this.#state.source) {
      this.#state({ source: true });
    }
  };

  @effect((i) => [i.#state.file, i.#state.source, i.#state.entered, i.line])
  #scrollToLine = () => {
    if (!this.line) return;
    requestAnimationFrame(() => {
      const lineEl =
        this.#codeBlockRef.value?.shadowRoot?.querySelector<HTMLElement>('.gem-highlight') || this.#lineRef.value;
      const mainEl = this.#mainRef.value;
      if (!lineEl || !mainEl?.clientHeight) return;
      const lineRect = lineEl.getBoundingClientRect();
      const mainRect = mainEl.getBoundingClientRect();
      if (!mainRect.height) return;
      const targetTop = mainEl.scrollTop + (lineRect.top - mainRect.top) - (mainEl.clientHeight - lineRect.height) / 2;
      mainEl.scrollTop = Math.max(0, targetTop);
    });
  };

  #renderText = (text: string) => {
    if (!this.line || this.line < 1) return text;
    let start = 0;
    for (let i = 1; i < this.line; i++) {
      const next = text.indexOf('\n', start);
      if (next === -1) return text;
      start = next + 1;
    }
    const nextNewline = text.indexOf('\n', start);
    const end = nextNewline === -1 ? text.length : nextNewline;
    const before = text.slice(0, start);
    const current = text.slice(start, end);
    const after = text.slice(end);
    return html`${before}<mark ${this.#lineRef}>${current || ' '}</mark>${after}`;
  };

  @template()
  #render = () => {
    const { file, loading, error, source, entered } = this.#state;
    const path = file?.path || this.path;
    const name = path.split(/[\\/]/).pop() || path;
    const markdown = file?.type === 'text' && /\.(md|markdown)$/i.test(path);
    const isText = file?.type === 'text';
    const text = isText ? file.text : '';
    const isSmall = isSmallTextFile(text);

    return html`
      <tap-page class="bg-bg text-text" .trackVisibility=${false} @full-show=${() => this.#state({ entered: true })}>
        <tap-navbar slot="header" title=${name} back default-back>
          <button
            v-if=${markdown}
            slot="right"
            type="button"
            class="min-h-11 cursor-pointer border-0 bg-transparent px-3 text-sm font-semibold text-highlight"
            @click=${() => this.#state({ source: !source })}
          >${i18n.get(source ? 'file.preview' : 'file.source')}</button>
        </tap-navbar>
        <deck-file-path
          slot="header"
          class="border-b border-border-strong bg-bg-light px-4 py-2 font-mono text-xs text-describe"
          path=${path}
        ></deck-file-path>
        <main ${this.#mainRef} class="h-full overflow-auto overscroll-contain">
          <!-- Highlighting and markdown wait for the Stack enter animation -->
          <deck-loading v-if=${loading || !entered} label=${i18n.get('file.loading')}></deck-loading>
          <deck-error
            v-else-if=${error}
            heading=${i18n.get('file.failed')}
            error=${error}
            .actions=${html`
              <button
                class="min-h-11 cursor-pointer rounded-xl border border-border bg-bg-light px-5 text-sm font-semibold text-text active:scale-[0.98]"
                @click=${openSettings}
              >
                ${i18n.get('global.openSettings')}
              </button>
            `}
            @retry=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></deck-error>
          <div v-else-if=${file?.type === 'image'} class="grid min-h-60 place-items-center p-4">
            <img class="max-w-full rounded-xl object-contain" src=${this.#state.imageUrl} alt=${name} />
          </div>
          <gem-bind-marked
            v-else-if=${markdown && !source}
            class="select-text mx-auto block max-w-[760px] p-5"
            .mdStyle=${fileViewerMarkdownStyle}
            .extensions=${this.#markdownExtensions}
            @click=${(event: MouseEvent) => openMessageLink(event, path.replace(/[^\\/]+$/, ''))}
          >${text}</gem-bind-marked>
          <tap-code-block
            v-else-if=${isText && isSmall}
            ${this.#codeBlockRef}
            class="select-text m-0 grid min-h-full w-full grid-rows-1 text-sm bg-transparent rounded-none"
            codelang=${getCodeLang(path)}
            highlight=${this.line ? String(this.line) : ''}
          >${text}</tap-code-block>
          <pre v-else class="select-text overflow-auto m-0 w-full p-4 font-mono text-sm leading-relaxed text-text" tabindex="0">${isText ? this.#renderText(text) : ''}</pre>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
