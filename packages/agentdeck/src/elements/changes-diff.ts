import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { GitDiffResult } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { diffColorScheme } from '../lib/diff';
import { agentdeckStore } from '../state/store';
import { icons } from '../styles/icons';

// Heavy element stays out of the initial bundle; markup upgrades once it defines itself.
import('@gem-bind/diff2html');

const pageStyle = css`
  :scope {
    height: 100%;
  }
  footer {
    height: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  }
`;

@customElement('deck-changes-diff-page')
@adoptedStyle(blockContainer)
@adoptedStyle(pageStyle)
@connectStore(agentdeckStore)
export class DeckChangesDiffPageElement extends GemElement {
  @property path = '';
  @property cwd = '';
  @property commit?: string;

  #state = createState({
    loading: true,
    error: '',
    result: undefined as GitDiffResult | undefined,
    revision: 0,
  });

  @effect((i) => [i.path, i.cwd, i.commit, i.#state.revision])
  #load = () => {
    let active = true;
    this.#state({ loading: true, error: '' });
    agentApi.gitDiff(this.cwd, this.path, this.commit).then(
      (result) => {
        if (active) this.#state({ result, loading: false });
      },
      (error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        this.#state({ loading: false, error: message });
      },
    );
    return () => {
      active = false;
    };
  };

  @template()
  #render = () => {
    const { loading, error, result } = this.#state;
    const fileName = this.path.split(/[/\\]/).filter(Boolean).pop() || this.path || i18n.get('changes.diffTitle');
    const stats = result?.stats;
    const diff = result?.diff;

    return html`
      <tap-page class="bg-bg text-text">
        <tap-navbar slot="header" title=${fileName} back default-back>
          <tap-use
            slot="right"
            role="button"
            title=${i18n.get('global.reload')}
            aria-label=${i18n.get('global.reload')}
            .element=${icons.refresh}
            @click=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></tap-use>
        </tap-navbar>
        <div slot="header" class="flex items-center gap-2 border-b border-border-strong bg-bg-light px-4 py-2 font-mono text-xs">
          <deck-file-path class="min-w-0 flex-1 text-describe" path=${this.path}></deck-file-path>
          <div v-if=${!!stats} class="flex shrink-0 items-center gap-1.5">
            ${stats?.insertions ? html`<span class="font-medium text-positive">+${stats.insertions}</span>` : ''}
            ${stats?.deletions ? html`<span class="font-medium text-negative">-${stats.deletions}</span>` : ''}
          </div>
        </div>

        <main class="flex h-full flex-col overflow-auto overscroll-contain">

          <!-- Loading state -->
          <div v-if=${loading} role="status" class="flex items-center justify-center gap-2 px-4 py-16 text-sm text-describe">
            <tap-use class="size-5 text-primary" .element=${icons.loading}></tap-use>
            ${i18n.get('changes.loadingDiff')}
          </div>

          <!-- Error state -->
          <div v-else-if=${error} role="alert" class="mx-auto max-w-lg px-5 py-16 text-center">
            <tap-use class="mb-3 size-8 text-negative" .element=${icons.error}></tap-use>
            <p class="m-0 font-semibold text-highlight">${i18n.get('changes.diffFailed')}</p>
            <p class="select-text mt-2 text-sm break-words text-negative">${error}</p>
            <button
              class="mt-4 min-h-11 cursor-pointer rounded-xl border border-primary/20 bg-primary-soft px-5 text-sm font-semibold text-primary-strong active:scale-[0.98]"
              @click=${() => this.#state({ revision: this.#state.revision + 1 })}
            >
              ${i18n.get('global.retry')}
            </button>
          </div>

          <!-- Empty diff -->
          <div v-else-if=${!diff?.trim()} class="px-5 py-16 text-center text-sm text-describe">
            <p class="m-0">${i18n.get('changes.noDiff')}</p>
          </div>

          <!-- Diff output -->
          <gem-bind-diff2html
            v-else
            class="shrink-0 grow border-none select-text"
            .colorScheme=${diffColorScheme}
            no-header
            compact-line-numbers
          >${diff || ''}</gem-bind-diff2html>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
