import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';

export type CwdCompletion = {
  value: string;
  isDirectory: boolean;
  directories: string[];
};

type Breadcrumb = {
  name: string;
  path: string;
};

const getBreadcrumbs = (currentPath: string, homePath: string): Breadcrumb[] => {
  const normCurrent = currentPath.replace(/[\\/]+$/, '') || '/';
  const normHome = homePath.replace(/[\\/]+$/, '') || '/';

  if (normHome && normHome !== '/' && (normCurrent === normHome || normCurrent.startsWith(`${normHome}/`))) {
    const relative = normCurrent.slice(normHome.length).replace(/^[\\/]+/, '');
    const crumbs: Breadcrumb[] = [{ name: '~', path: normHome }];
    if (!relative) return crumbs;
    let accumulated = normHome;
    for (const part of relative.split(/[\\/]+/).filter(Boolean)) {
      accumulated = `${accumulated}/${part}`;
      crumbs.push({ name: part, path: accumulated });
    }
    return crumbs;
  }

  if (normCurrent === '/') {
    return [{ name: '/', path: '/' }];
  }
  const parts = normCurrent.split(/[\\/]+/).filter(Boolean);
  const crumbs: Breadcrumb[] = [{ name: '/', path: '/' }];
  let accumulated = '';
  for (const part of parts) {
    accumulated = `${accumulated}/${part}`;
    crumbs.push({ name: part, path: accumulated });
  }
  return crumbs;
};

const getParentPath = (currentPath: string): string | null => {
  const norm = currentPath.replace(/[\\/]+$/, '');
  if (!norm || norm === '/') return null;
  const parent = norm.replace(/[\\/][^\\/]+$/, '');
  return parent || '/';
};

const sortDirectories = (dirs: string[]) => {
  return [...dirs].sort((a, b) => {
    const nameA =
      a
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() || a;
    const nameB =
      b
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() || b;
    const dotA = nameA.startsWith('.');
    const dotB = nameB.startsWith('.');
    if (dotA !== dotB) return dotA ? 1 : -1;
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
  });
};

const getFolderName = (currentPath: string, homePath: string) => {
  const normCurrent = currentPath.replace(/[\\/]+$/, '') || '/';
  const normHome = homePath.replace(/[\\/]+$/, '') || '/';
  if (normCurrent === normHome) return '~';
  if (normCurrent === '/') return '/';
  return (
    normCurrent
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() || normCurrent
  );
};

const style = css`
  :scope {
    display: block;
  }
`;

@customElement('deck-cwd-picker')
@adoptedStyle(style)
export class DeckCwdPickerElement extends GemElement {
  @property complete?: (input: string) => Promise<CwdCompletion>;
  @property creating = false;
  @property error = '';
  @emitter confirm: Emitter<string>;

  #state = createState({
    homePath: '',
    currentPath: '',
    directories: [] as string[],
    loading: true,
    navigatingPath: '',
    browseError: '',
  });
  #requestToken = 0;

  @willMount()
  #init = () => void this.#navigateTo('');

  #navigateTo = async (targetPath: string) => {
    const token = ++this.#requestToken;
    const isInitial = !this.#state.currentPath;
    this.#state({
      loading: isInitial,
      navigatingPath: targetPath,
      browseError: '',
    });
    try {
      const result = await this.complete?.(targetPath);
      if (token !== this.#requestToken) return;
      const resolvedPath = result?.value || targetPath;
      this.#state({
        homePath: this.#state.homePath || resolvedPath,
        currentPath: resolvedPath,
        directories: sortDirectories(result?.directories ?? []),
        loading: false,
        navigatingPath: '',
        browseError: '',
      });
    } catch (error) {
      if (token !== this.#requestToken) return;
      this.#state({
        loading: false,
        navigatingPath: '',
        browseError: error instanceof Error ? error.message : '读取目录失败',
      });
    }
  };

  #confirm = () => {
    const { currentPath } = this.#state;
    if (!currentPath || this.creating) return;
    this.confirm(currentPath);
  };

  @template()
  #render = () => {
    const { homePath, currentPath, directories, loading, navigatingPath, browseError } = this.#state;
    const crumbs = getBreadcrumbs(currentPath, homePath);
    const parentPath = getParentPath(currentPath);
    const currentName = getFolderName(currentPath, homePath);

    return html`
      <div class="w-full">
        <!-- Breadcrumbs bar -->
        <div class="mb-3 flex items-center gap-1.5 overflow-x-auto rounded-[12px] border border-border/70 bg-bg px-3 py-2 no-scrollbar">
          <span class="text-xs font-bold tracking-wider text-describe uppercase shrink-0">位置:</span>
          ${crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            const isNavigatingThis = navigatingPath === crumb.path;
            return html`
              ${index > 0 ? html`<tap-use class="size-2.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>` : ''}
              <button
                type="button"
                class=${classMap({
                  'shrink-0 rounded-md px-1.5 py-0.5 font-mono text-sm transition-colors border-0 inline-flex items-center gap-1': true,
                  'bg-primary-soft font-bold text-primary-strong': isLast,
                  'cursor-pointer bg-transparent text-describe hover:text-highlight active:bg-bg-hover': !isLast,
                })}
                ?disabled=${this.creating || Boolean(navigatingPath) || isLast}
                @click=${() => this.#navigateTo(crumb.path)}
              >
                <tap-use v-if=${isNavigatingThis} class="size-2.5 animate-spin text-primary" .element=${icons.loading}></tap-use>
                ${crumb.name}
              </button>
            `;
          })}
        </div>

        <!-- Browse error notification -->
        <div
          v-if=${browseError}
          class="mb-3 flex items-center gap-2 rounded-[13px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2.5 text-sm leading-relaxed text-negative"
        >
          <tap-use class="size-3.5 shrink-0 text-negative" .element=${icons.error}></tap-use>
          <span class="min-w-0 truncate">${browseError}</span>
        </div>

        <!-- Directory list -->
        <div class="max-h-[42vh] min-h-[160px] overflow-y-auto rounded-[16px] border border-border bg-bg-light/60">
          <div v-if=${loading} class="flex items-center justify-center gap-2 py-12 text-sm text-describe">
            <tap-use class="size-4 animate-spin" .element=${icons.loading}></tap-use>
            正在读取目录…
          </div>

          <div v-else class="divide-y divide-border/60">
            <!-- Parent directory row -->
            <button
              v-if=${parentPath !== null}
              type="button"
              class="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-2.5 text-left transition-colors hover:bg-bg-hover active:bg-bg-hover disabled:pointer-events-none disabled:opacity-50"
              ?disabled=${this.creating || Boolean(navigatingPath)}
              @click=${() => parentPath && this.#navigateTo(parentPath)}
            >
              <span class="grid size-7 shrink-0 place-items-center rounded-[8px] border border-border/60 bg-bg text-describe">
                <tap-use
                  class=${classMap({
                    'size-3.5': true,
                    'animate-spin text-primary': navigatingPath === parentPath,
                  })}
                  .element=${navigatingPath === parentPath ? icons.loading : icons.back}
                ></tap-use>
              </span>
              <span class="font-mono text-sm font-semibold text-describe">.. (返回上一级)</span>
            </button>

            <!-- Subdirectories list -->
            ${directories.map((directory) => {
              const name =
                directory
                  .split(/[\\/]+/)
                  .filter(Boolean)
                  .pop() || directory;
              const isHidden = name.startsWith('.');
              const isNavigatingThis = navigatingPath === directory;
              return html`
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-4 py-3 text-left transition-colors hover:bg-bg-hover active:bg-bg-hover disabled:pointer-events-none disabled:opacity-50"
                  title=${directory}
                  ?disabled=${this.creating || Boolean(navigatingPath)}
                  @click=${() => this.#navigateTo(directory)}
                >
                  <div class="flex min-w-0 items-center gap-3">
                    <span
                      class=${classMap({
                        'grid size-7 shrink-0 place-items-center rounded-[8px]': true,
                        'bg-primary-soft text-primary-strong': !isHidden,
                        'border border-border/50 bg-bg text-disabled': isHidden,
                      })}
                    >
                      <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19.5 21a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-1.5V9a3 3 0 0 0-3-3h-4.5a3 3 0 0 0-2.12.88L6.88 8.38A3 3 0 0 0 4.76 9.25H4.5A3 3 0 0 0 1.5 12.25V18a3 3 0 0 0 3 3h15Z" opacity="0.4"/>
                        <path d="M4.5 9.25h10.5a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H4.5A3 3 0 0 1 1.5 18v-5.75a3 3 0 0 1 3-3Z"/>
                      </svg>
                    </span>
                    <span
                      class=${classMap({
                        'truncate font-mono text-sm font-medium': true,
                        'text-text': !isHidden,
                        'text-describe': isHidden,
                      })}
                    >
                      ${name}
                    </span>
                  </div>
                  <tap-use
                    class=${classMap({
                      'size-3.5 shrink-0': true,
                      'animate-spin text-primary': isNavigatingThis,
                      'text-disabled': !isNavigatingThis,
                    })}
                    .element=${isNavigatingThis ? icons.loading : icons.right}
                  ></tap-use>
                </button>
              `;
            })}

            <!-- Empty directory notice -->
            <div v-if=${!directories.length} class="px-4 py-8 text-center text-sm text-describe">
              此目录下没有子目录，可直接点击下方按钮以此为工作区
            </div>
          </div>
        </div>

        <!-- Action error message -->
        <div
          v-if=${this.error}
          class="mt-3 rounded-[13px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2.5 text-sm leading-relaxed text-negative"
        >
          ${this.error}
        </div>

        <!-- Confirm button -->
        <button
          type="button"
          class="mt-3 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[15px] border-0 bg-primary px-4 text-sm font-bold text-white shadow-primary transition-transform active:scale-[0.985] disabled:cursor-default disabled:bg-border disabled:text-disabled disabled:shadow-none disabled:active:scale-100"
          ?disabled=${this.creating || Boolean(navigatingPath) || !currentPath}
          @click=${this.#confirm}
        >
          <tap-use v-if=${this.creating} class="size-4 animate-spin" .element=${icons.loading}></tap-use>
          <span>${this.creating ? '正在创建会话…' : `在「${currentName}」新建会话`}</span>
        </button>
      </div>
    `;
  };
}
