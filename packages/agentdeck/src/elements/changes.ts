import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { GitFileStatus, GitShowResult, GitStatusResult } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { openChangesDiff, openGitLog } from '../navigation';
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

const diffCounts = ({ insertions, deletions }: { insertions?: number; deletions?: number }) => html`
  ${insertions ? html`<span class="font-medium text-positive">+${insertions}</span>` : ''}
  ${deletions ? html`<span class="font-medium text-negative">-${deletions}</span>` : ''}
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
  /** 提供时展示该提交的更改，否则展示工作区更改 */
  @property commit?: string;

  #state = createState({
    loading: true,
    error: '',
    result: undefined as (GitStatusResult | GitShowResult) | undefined,
    revision: 0,
    entered: false,
  });

  @effect((i) => [i.cwd, i.commit, i.#state.revision])
  #load = () => {
    let active = true;
    this.#state({ loading: true, error: '' });
    (this.commit ? agentApi.gitShow(this.cwd, this.commit) : agentApi.gitStatus(this.cwd)).then(
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
    openChangesDiff(filePath, this.cwd, this.commit);
  };

  @template()
  #render = () => {
    const { loading, error, result, entered } = this.#state;
    const files = result?.files ?? [];
    const stats = result?.stats;
    const commit = result && 'commit' in result ? result.commit : undefined;
    const branch = result && 'branch' in result ? result.branch : undefined;
    const repoName = result?.repo ? displayPath(result.repo) : displayPath(this.cwd);

    return html`
      <tap-page class="bg-bg text-text" .trackVisibility=${false} @full-show=${() => this.#state({ entered: true })}>
        <tap-navbar slot="header" title=${commit?.summary || i18n.get('changes.title')} back default-back>
          <tap-use
            slot="right"
            role="button"
            title=${i18n.get('global.reload')}
            aria-label=${i18n.get('global.reload')}
            .element=${icons.refresh}
            @click=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></tap-use>
        </tap-navbar>
        <div slot="header" class="flex flex-wrap items-center justify-between gap-2 border-b border-border-strong bg-bg-light px-4 py-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate font-mono text-xs font-medium text-text">${repoName}</span>
            <button
              v-if=${!!branch}
              type="button"
              class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-primary-soft px-1.5 py-0.5 text-xs font-medium text-primary-strong active:scale-[0.95]"
              title=${i18n.get('changes.history')}
              @click=${() => openGitLog(this.cwd)}
            >
              <tap-use class="size-3" .element=${icons.gitBranch}></tap-use>
              ${branch}
            </button>
            <span
              v-if=${!!commit}
              class="shrink-0 rounded-md bg-primary-soft px-1.5 py-0.5 font-mono text-xs font-medium text-primary-strong"
            >
              ${commit?.shortId}
            </span>
          </div>
          <div v-if=${!loading && !error} class="flex items-center gap-2 text-xs">
            <span class="text-describe">
              ${files.length === 1 ? i18n.get('changes.fileChanged') : i18n.get('changes.filesChanged', String(files.length))}
            </span>
            <div v-if=${!!stats} class="flex items-center gap-1.5 font-mono text-xs">${stats && diffCounts(stats)}</div>
          </div>
        </div>

        <main class="h-full overflow-auto overscroll-contain">
          <!-- Loading state; the file list waits for the Stack enter animation -->
          <deck-loading v-if=${loading || !entered} label=${i18n.get('changes.loading')}></deck-loading>

          <!-- Error state -->
          <deck-error
            v-else-if=${error}
            heading=${i18n.get('changes.failed')}
            error=${error}
            @retry=${() => this.#state({ revision: this.#state.revision + 1 })}
          ></deck-error>

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
                      <deck-file-path class="pointer-events-none font-mono text-sm text-text" path=${file.path}></deck-file-path>
                      <div class="mt-0.5 flex items-center gap-1.5 text-xs text-describe">
                        <span>${badge.text}</span>
                        <span class="flex items-center gap-1.5 font-mono">${diffCounts(file)}</span>
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
