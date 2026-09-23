import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { GitFileStatus, GitStatusResult } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { openChangesDiff } from '../navigation';
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

const badgeInfo = (status: string) => {
  switch (status) {
    case 'added':
      return { label: 'A', text: i18n.get('changes.added'), class: 'bg-positive/10 text-positive border-positive/25' };
    case 'deleted':
      return {
        label: 'D',
        text: i18n.get('changes.deleted'),
        class: 'bg-negative/10 text-negative border-negative/25',
      };
    case 'untracked':
      return {
        label: 'U',
        text: i18n.get('changes.untracked'),
        class: 'bg-informative/10 text-informative border-informative/25',
      };
    case 'renamed':
      return {
        label: 'R',
        text: i18n.get('changes.renamed'),
        class: 'bg-primary-soft text-primary-strong border-primary/25',
      };
    default:
      return { label: 'M', text: i18n.get('changes.modified'), class: 'bg-notice/10 text-notice border-notice/25' };
  }
};

@customElement('deck-changes-page')
@adoptedStyle(blockContainer)
@adoptedStyle(pageStyle)
@connectStore(agentdeckStore)
export class DeckChangesPageElement extends GemElement {
  @property cwd = '';

  #state = createState({
    loading: true,
    error: '',
    result: undefined as GitStatusResult | undefined,
    revision: 0,
  });

  @effect((i) => [i.cwd, i.#state.revision])
  #load = () => {
    let active = true;
    this.#state({ loading: true, error: '' });
    agentApi.gitStatus(this.cwd).then(
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

  #onFileClick = (filePath: string) => {
    openChangesDiff(filePath, this.cwd);
  };

  @template()
  #render = () => {
    const { loading, error, result } = this.#state;
    const files = result?.files ?? [];
    const stats = result?.stats;
    const branch = result?.branch;
    const repoName = result?.repo ? displayPath(result.repo) : displayPath(this.cwd);

    return html`
      <tap-page class="bg-bg text-text">
        <tap-navbar slot="header" title=${i18n.get('changes.title')} back default-back>
          <button
            slot="right"
            type="button"
            class="min-h-11 cursor-pointer border-0 bg-transparent px-3 text-describe transition-colors hover:text-text active:scale-[0.95]"
            title=${i18n.get('global.reload')}
            @click=${() => this.#state({ revision: this.#state.revision + 1 })}
          >
            <tap-use class="size-4" .element=${icons.refresh}></tap-use>
          </button>
        </tap-navbar>

        <main class="h-full overflow-auto overscroll-contain">
          <!-- Summary Header -->
          <div class="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-light/95 px-4 py-2.5 backdrop-blur-md">
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate font-mono text-xs font-medium text-text">${repoName}</span>
              <span
                v-if=${branch}
                class="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary-soft px-1.5 py-0.5 text-xs font-medium text-primary-strong"
              >
                <tap-use class="size-3" .element=${icons.gitBranch}></tap-use>
                ${branch}
              </span>
            </div>
            <div v-if=${!loading && !error} class="flex items-center gap-2 text-xs">
              <span class="text-describe">
                ${files.length === 1 ? i18n.get('changes.fileChanged') : i18n.get('changes.filesChanged', String(files.length))}
              </span>
              <div v-if=${!!stats} class="flex items-center gap-1.5 font-mono text-xs">
                ${stats?.insertions ? html`<span class="font-medium text-positive">+${stats.insertions}</span>` : ''}
                ${stats?.deletions ? html`<span class="font-medium text-negative">-${stats.deletions}</span>` : ''}
              </div>
            </div>
          </div>

          <!-- Loading state -->
          <div v-if=${loading} role="status" class="flex items-center justify-center gap-2 px-4 py-16 text-sm text-describe">
            <tap-use class="size-5 text-primary" .element=${icons.loading}></tap-use>
            ${i18n.get('changes.loading')}
          </div>

          <!-- Error state -->
          <div v-else-if=${error} role="alert" class="mx-auto max-w-lg px-5 py-16 text-center">
            <tap-use class="mb-3 size-8 text-negative" .element=${icons.error}></tap-use>
            <p class="m-0 font-semibold text-highlight">${i18n.get('changes.failed')}</p>
            <p class="select-text mt-2 text-sm break-words text-negative">${error}</p>
            <button
              class="mt-4 min-h-11 cursor-pointer rounded-xl border border-primary/20 bg-primary-soft px-5 text-sm font-semibold text-primary-strong active:scale-[0.98]"
              @click=${() => this.#state({ revision: this.#state.revision + 1 })}
            >
              ${i18n.get('global.retry')}
            </button>
          </div>

          <!-- Clean state (no changes) -->
          <div v-else-if=${files.length === 0} class="px-5 py-16 text-center text-sm text-describe">
            <div class="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-positive/10 text-positive">
              <tap-use class="size-6" .element=${icons.check}></tap-use>
            </div>
            <p class="m-0 font-medium text-highlight">${i18n.get('changes.noChanges')}</p>
          </div>

          <!-- Changes list -->
          <div v-else class="p-2 space-y-1">
            ${files.map((file: GitFileStatus) => {
              const badge = badgeInfo(file.status);
              return html`
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-bg-hover active:bg-bg-hover"
                  title=${file.path}
                  @click=${() => this.#onFileClick(file.path)}
                >
                  <div class="flex min-w-0 items-center gap-2.5">
                    <span
                      class=${classMap({
                        'inline-flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-mono font-bold': true,
                        [badge.class]: true,
                      })}
                      title=${badge.text}
                    >
                      ${badge.label}
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="truncate font-mono text-sm text-text">${file.path}</div>
                      <div class="mt-0.5 flex items-center gap-1.5 text-xs text-describe">
                        <span>${badge.text}</span>
                        <span
                          v-if=${file.staged}
                          class="rounded bg-positive/10 px-1 py-0.5 text-[10px] font-medium text-positive border border-positive/20"
                        >
                          ${i18n.get('changes.staged')}
                        </span>
                      </div>
                    </div>
                  </div>
                  <tap-use class="size-3.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>
                </button>
              `;
            })}
          </div>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
