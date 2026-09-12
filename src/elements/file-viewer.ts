import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { RemoteFile } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { fileViewerMarkdownStyle, markdownExtensions } from '../lib/markdown';
import { openFileBrowser, openMessageLink, openSettings } from '../navigation';
import { icons } from '../styles/icons';

const style = css`
  :scope {
    height: 100%;
  }
  mark {
    background: var(--color-primary-soft);
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
    loading: true,
    error: '',
    revision: 0,
    source: false,
  });
  #lineRef = createRef<HTMLElement>();

  @effect((i) => [i.path, i.cwd, i.line, i.#state.revision])
  #read = () => {
    let active = true;
    this.#state({ file: undefined, loading: true, error: '', source: Boolean(this.line) });
    agentApi.readFile(this.path, this.cwd).then(
      (file) => {
        if (active) this.#state({ file, loading: false });
      },
      (error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        if (/is a directory/i.test(message)) {
          Stack.pop();
          openFileBrowser(this.path, this.cwd);
          return;
        }
        this.#state({ loading: false, error: message });
      },
    );
    return () => {
      active = false;
    };
  };

  @effect((i) => [i.#state.file, i.#state.source])
  #scrollToLine = () => {
    const frame = requestAnimationFrame(() => this.#lineRef.value?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  };

  #renderText = (text: string) => {
    if (!this.line) return text;
    const lines = text.split('\n');
    const index = this.line - 1;
    if (index >= lines.length) return text;
    return html`${lines.slice(0, index).join('\n')}${index ? '\n' : ''}<mark ${this.#lineRef}>${lines[index] || ' '}</mark>${index < lines.length - 1 ? '\n' : ''}${lines.slice(index + 1).join('\n')}`;
  };

  @template()
  #render = () => {
    const { file, loading, error, source } = this.#state;
    const path = file?.path || this.path;
    const name = path.split(/[\\/]/).pop() || path;
    const markdown = file?.type === 'text' && /\.(md|markdown)$/i.test(path);
    return html`
      <tap-page class="bg-bg text-text">
        <tap-navbar slot="header" title=${name} back @backclick=${() => Stack.pop()}>
          <button
            v-if=${markdown}
            slot="right"
            type="button"
            class="min-h-11 cursor-pointer border-0 bg-transparent px-3 text-sm font-semibold text-primary-strong"
            @click=${() => this.#state({ source: !source })}
          >${i18n.get(source ? 'file.preview' : 'file.source')}</button>
        </tap-navbar>
        <main class="h-full overflow-auto overscroll-contain">
          <div class="sticky top-0 z-10 border-b border-border bg-bg-light px-4 py-2 font-mono text-xs break-all text-describe">${path}</div>
          <div v-if=${loading} role="status" class="flex items-center justify-center gap-2 px-4 py-12 text-sm text-describe">
            <tap-use class="size-5 text-primary" .element=${icons.loading}></tap-use>
            ${i18n.get('file.loading')}
          </div>
          <div v-else-if=${error} role="alert" class="mx-auto max-w-lg px-5 py-12 text-center">
            <tap-use class="mb-3 size-8 text-negative" .element=${icons.error}></tap-use>
            <p class="m-0 font-semibold text-highlight">${i18n.get('file.failed')}</p>
            <p class="mt-2 text-sm break-words text-negative">${error}</p>
            <div class="flex justify-center gap-3">
              <button
                class="min-h-11 cursor-pointer rounded-xl border border-primary/20 bg-primary-soft px-4 text-sm font-semibold text-primary-strong"
                @click=${() => this.#state({ revision: this.#state.revision + 1 })}
              >${i18n.get('global.retry')}</button>
              <button
                class="min-h-11 cursor-pointer rounded-xl border border-border bg-bg-light px-4 text-sm font-semibold text-text"
                @click=${openSettings}
              >${i18n.get('global.openSettings')}</button>
            </div>
          </div>
          <div v-else-if=${file?.type === 'image'} class="grid min-h-60 place-items-center p-4">
            <img class="max-w-full rounded-xl object-contain" src=${file?.type === 'image' ? `data:${file.mimeType};base64,${file.data}` : ''} alt=${name} />
          </div>
          <gem-bind-marked
            v-else-if=${markdown && !source}
            class="mx-auto block max-w-[760px] p-5"
            .mdStyle=${fileViewerMarkdownStyle}
            .extensions=${markdownExtensions}
            @click=${(event: MouseEvent) => openMessageLink(event, path.replace(/[^\\/]+$/, ''))}
          >${file?.type === 'text' ? file.text : ''}</gem-bind-marked>
          <pre v-else class="max-w-full overflow-auto m-0 min-w-full w-max p-4 font-mono text-sm leading-relaxed text-text" tabindex="0">${file?.type === 'text' ? this.#renderText(file.text) : ''}</pre>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
