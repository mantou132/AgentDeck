import type { Emitter } from '@mantou/gem/lib/decorators';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';

import type { BrowseEntry } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { displayPath, getBreadcrumbs, getParentPath } from '../lib/path';
import { openFileViewer } from '../navigation';
import { icons } from '../styles/icons';

const browserStyle = css`
  :scope {
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: 100%;
  }
  .entries-container {
    max-height: 42dvh;
    min-height: 10rem;
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }
`;

const pageStyle = css`
  :scope {
    height: 100%;
  }
  deck-file-browser {
    height: 100%;
  }
  deck-file-browser .entries-container {
    max-height: none;
    flex: 1;
  }
  footer {
    height: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  }
`;

@customElement('deck-file-browser')
@adoptedStyle(blockContainer)
@adoptedStyle(browserStyle)
export class DeckFileBrowserElement extends GemElement {
  @property path = '';
  @property cwd = '';
  @property emptyText = '';
  @boolattribute directoriesOnly: boolean;

  @emitter change: Emitter<string>;
  @emitter navstart: Emitter<string>;

  #state = createState({
    homePath: '',
    currentPath: '',
    entries: [] as BrowseEntry[],
    loading: true,
    navigatingPath: '',
    browseError: '',
  });
  #requestToken = 0;
  #breadcrumbsRef = createRef<HTMLElement>();

  @effect((i) => [i.path, i.cwd])
  #init = () => {
    void this.#navigateTo(this.path);
  };

  @effect((i) => [i.#state.currentPath])
  #scrollBreadcrumbs = () => {
    requestAnimationFrame(() => {
      const el = this.#breadcrumbsRef.value;
      if (el) el.scrollLeft = el.scrollWidth;
    });
  };

  #navigateTo = async (targetPath: string) => {
    const token = ++this.#requestToken;
    const isInitial = !this.#state.currentPath;
    this.#state({
      loading: isInitial,
      navigatingPath: targetPath,
      browseError: '',
    });
    this.navstart(targetPath);
    try {
      const result = await agentApi.browseFiles(targetPath, {
        cwd: this.cwd,
        type: this.directoriesOnly ? 'directory' : 'all',
      });
      if (token !== this.#requestToken) return;
      const resolvedPath = result?.path || targetPath;
      const homePath = result?.home || this.#state.homePath;
      this.#state({
        homePath,
        currentPath: resolvedPath,
        entries: result?.entries ?? [],
        loading: false,
        navigatingPath: '',
        browseError: '',
      });
      this.change(resolvedPath);
    } catch (error) {
      if (token !== this.#requestToken) return;
      this.#state({
        loading: false,
        navigatingPath: '',
        browseError: error instanceof Error ? error.message : i18n.get('cwdPicker.browseError'),
      });
    }
  };

  #onFileClick = (file: string) => {
    openFileViewer(file, this.cwd || this.#state.currentPath);
  };

  @template()
  #render = () => {
    const { homePath, currentPath, entries, loading, navigatingPath, browseError } = this.#state;
    const crumbs = getBreadcrumbs(currentPath, homePath);
    const parentPath = getParentPath(currentPath);
    const hasEntries = entries.length > 0;

    return html`
      <div
        ${this.#breadcrumbsRef}
        class="mb-4 flex min-h-11 items-center gap-1 overflow-x-auto rounded-xl bg-bg px-2 py-1.5 no-scrollbar"
      >
        ${crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          const isNavigatingThis = navigatingPath === crumb.path;
          return html`
            ${index > 0 ? html`<tap-use class="size-2.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>` : ''}
            <button
              type="button"
              class=${classMap({
                'inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border-0 px-2 py-1 font-mono text-sm outline-none transition-colors': true,
                'bg-transparent font-medium text-highlight': isLast,
                'cursor-pointer bg-transparent text-describe hover:text-highlight active:bg-bg-hover': !isLast,
              })}
              ?disabled=${Boolean(navigatingPath) || isLast}
              @click=${() => this.#navigateTo(crumb.path)}
            >
              <tap-use v-if=${isNavigatingThis} class="size-2.5 text-primary" .element=${icons.loading}></tap-use>
              ${crumb.name}
            </button>
          `;
        })}
      </div>

      <div
        v-if=${browseError}
        class="mb-3 flex items-center gap-2 rounded-[13px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2.5 text-sm leading-relaxed text-negative"
      >
        <tap-use class="size-3.5 shrink-0 text-negative" .element=${icons.error}></tap-use>
        <span class="min-w-0 flex-1">${browseError}</span>
        <button
          class="shrink-0 cursor-pointer rounded-lg border border-negative/25 bg-bg-light px-2.5 py-1.5 font-semibold disabled:opacity-45"
          ?disabled=${loading || Boolean(navigatingPath)}
          @click=${() => this.#navigateTo(currentPath)}
        >
          ${i18n.get('cwdPicker.retry')}
        </button>
      </div>

      <div class="entries-container">
        <div v-if=${loading} class="flex items-center justify-center gap-2 py-12 text-sm text-describe">
          <tap-use class="size-4" .element=${icons.loading}></tap-use>
          ${i18n.get('cwdPicker.reading')}
        </div>

        <div v-else class="divide-y divide-border/60">
          <button
            v-if=${parentPath !== null}
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-1 py-3 text-left transition-colors hover:bg-bg-hover active:bg-bg-hover disabled:pointer-events-none disabled:opacity-50"
            ?disabled=${Boolean(navigatingPath)}
            @click=${() => parentPath && this.#navigateTo(parentPath)}
          >
            <span class="grid size-6 shrink-0 place-items-center text-describe">
              <tap-use
                class=${classMap({
                  'size-3.5': true,
                  'text-primary': navigatingPath === parentPath,
                })}
                .element=${navigatingPath === parentPath ? icons.loading : icons.back}
              ></tap-use>
            </span>
            <span class="text-sm text-describe">${i18n.get('cwdPicker.parentDir')}</span>
          </button>

          ${entries.map((entry) => {
            const isHidden = entry.name.startsWith('.');
            const isNavigatingThis = navigatingPath === entry.path;
            if (entry.isDirectory) {
              return html`
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-1 py-3.5 text-left transition-colors hover:bg-bg-hover active:bg-bg-hover disabled:pointer-events-none disabled:opacity-50"
                  title=${entry.path}
                  ?disabled=${Boolean(navigatingPath)}
                  @click=${() => this.#navigateTo(entry.path)}
                >
                  <div class="flex min-w-0 items-center gap-3">
                    <span
                      class=${classMap({
                        'grid size-6 shrink-0 place-items-center': true,
                        'text-describe': !isHidden,
                        'text-disabled': isHidden,
                      })}
                    >
                      <tap-use class="size-[18px]" .element=${icons.folder}></tap-use>
                    </span>
                    <span
                      class=${classMap({
                        'truncate font-mono text-sm font-medium': true,
                        'text-text': !isHidden,
                        'text-describe': isHidden,
                      })}
                    >
                      ${entry.name}
                    </span>
                  </div>
                  <tap-use
                    class=${classMap({
                      'size-3.5 shrink-0': true,
                      'text-primary': isNavigatingThis,
                      'text-disabled': !isNavigatingThis,
                    })}
                    .element=${isNavigatingThis ? icons.loading : icons.right}
                  ></tap-use>
                </button>
              `;
            }

            return html`
              <button
                type="button"
                class="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-1 py-3 text-left transition-colors hover:bg-bg-hover active:bg-bg-hover disabled:pointer-events-none disabled:opacity-50"
                title=${entry.path}
                ?disabled=${Boolean(navigatingPath)}
                @click=${() => this.#onFileClick(entry.path)}
              >
                <div class="flex min-w-0 items-center gap-3">
                  <span
                    class=${classMap({
                      'grid size-6 shrink-0 place-items-center': true,
                      'text-describe': !isHidden,
                      'text-disabled': isHidden,
                    })}
                  >
                    <tap-use class="size-[18px]" .element=${icons.file}></tap-use>
                  </span>
                  <span
                    class=${classMap({
                      'truncate font-mono text-sm': true,
                      'text-text': !isHidden,
                      'text-describe': isHidden,
                    })}
                  >
                    ${entry.name}
                  </span>
                </div>
              </button>
            `;
          })}

          <div v-if=${!hasEntries && !browseError} class="px-4 py-8 text-center text-sm text-describe">
            ${this.emptyText || i18n.get('fileBrowser.emptyDir')}
          </div>
        </div>
      </div>
    `;
  };
}

@customElement('deck-file-browser-page')
@adoptedStyle(blockContainer)
@adoptedStyle(pageStyle)
export class DeckFileBrowserPageElement extends GemElement {
  @property path = '';
  @property cwd = '';

  #state = createState({
    currentPath: '',
  });

  #title = () => {
    const p = this.#state.currentPath || this.path;
    if (displayPath(p) === '~') return '~';
    return (
      p
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() ||
      p ||
      '/'
    );
  };

  @template()
  #render = () => html`
    <tap-page class="bg-bg text-text">
      <tap-navbar slot="header" title=${this.#title()} back @backclick=${() => Stack.pop()}></tap-navbar>
      <main class="h-full overflow-hidden p-4">
        <deck-file-browser
          .path=${this.path}
          .cwd=${this.cwd}
          @change=${(e: CustomEvent<string>) => this.#state({ currentPath: e.detail })}
        ></deck-file-browser>
      </main>
      <footer slot="footer"></footer>
    </tap-page>
  `;
}
