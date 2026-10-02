import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { Time } from '@mantou/tap-ui/lib/time';
import type { GitLogResult } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { openChanges } from '../navigation';
import { agentdeckStore } from '../state/store';
import { icons } from '../styles/icons';

const pageStyle = css`
  :scope {
    height: 100%;
  }
  footer {
    height: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  }
`;

@customElement('deck-git-log-page')
@adoptedStyle(blockContainer)
@adoptedStyle(pageStyle)
@connectStore(agentdeckStore)
export class DeckGitLogPageElement extends GemElement {
  @property cwd = '';

  #state = createState({
    loading: true,
    error: '',
    result: undefined as GitLogResult | undefined,
    revision: 0,
  });

  @effect((i) => [i.cwd, i.#state.revision])
  #load = () => {
    let active = true;
    this.#state({ loading: true, error: '' });
    agentApi.gitLog(this.cwd).then(
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
    const commits = result?.commits ?? [];
    const branch = result?.branch;
    const repoName = result?.repo ? displayPath(result.repo) : displayPath(this.cwd);

    return html`
      <tap-page class="bg-bg text-text">
        <tap-navbar slot="header" title=${i18n.get('changes.history')} back default-back>
          <tap-use
            slot="right"
            role="button"
            title=${i18n.get('global.reload')}
            aria-label=${i18n.get('global.reload')}
            .element=${icons.refresh}
            @click=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></tap-use>
        </tap-navbar>
        <div slot="header" class="flex min-w-0 items-center gap-2 border-b border-border-strong bg-bg-light px-4 py-2.5">
          <span class="truncate font-mono text-xs font-medium text-text">${repoName}</span>
          <span
            v-if=${!!branch}
            class="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary-soft px-1.5 py-0.5 text-xs font-medium text-primary-strong"
          >
            <tap-use class="size-3" .element=${icons.gitBranch}></tap-use>
            ${branch}
          </span>
        </div>

        <main class="h-full overflow-auto overscroll-contain">
          <!-- Loading state -->
          <deck-loading v-if=${loading} label=${i18n.get('changes.loadingHistory')}></deck-loading>

          <!-- Error state -->
          <deck-error
            v-else-if=${error}
            heading=${i18n.get('changes.historyFailed')}
            error=${error}
            @retry=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></deck-error>

          <!-- Empty state -->
          <div v-else-if=${commits.length === 0} class="px-5 py-16 text-center text-sm text-describe">
            <p class="m-0">${i18n.get('changes.noCommits')}</p>
          </div>

          <!-- Commit list -->
          <div v-else class="p-2 space-y-1">
            ${commits.map(
              (commit) => html`
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-bg-hover active:bg-bg-hover"
                  title=${commit.summary}
                  @click=${() => openChanges(this.cwd, commit.id)}
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm text-text">${commit.summary}</div>
                    <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-describe">
                      <span class="shrink-0 font-mono">${commit.shortId}</span>
                      <span class="truncate">${commit.author}</span>
                      <span class="shrink-0">
                        ${new Time().relativeTimeFormat(new Time(commit.time), { lang: i18n.currentLanguage })}
                      </span>
                    </div>
                  </div>
                  <tap-use class="size-3.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>
                </button>
              `,
            )}
          </div>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
