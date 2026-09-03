import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';

import { displayPath } from '../path';

export type CwdCompletion = {
  value: string;
  isDirectory: boolean;
  directories: string[];
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
    value: '',
    directories: [] as string[],
    loading: true,
    browseError: '',
  });
  #requestToken = 0;

  @willMount()
  #init = () => void this.#update('');

  #update = async (input: string) => {
    const token = ++this.#requestToken;
    this.#state({ value: input, directories: [], loading: true, browseError: '' });
    try {
      const result = await this.complete?.(input);
      if (token !== this.#requestToken) return;
      this.#state({
        value: input || result?.value || '',
        directories: result?.directories ?? [],
        loading: false,
      });
    } catch (error) {
      if (token !== this.#requestToken) return;
      this.#state({ loading: false, browseError: error instanceof Error ? error.message : '读取目录失败' });
    }
  };

  #enter = (directory: string) => this.#update(`${directory.replace(/[\\/]+$/, '')}/`);

  #confirm = () => {
    const value = this.#state.value.trim().replace(/[\\/]+$/, '');
    if (!value || this.creating) return;
    this.confirm(value);
  };

  #onInput = (event: InputEvent) => this.#state({ value: (event.target as HTMLInputElement).value });

  #onKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.target as HTMLInputElement).blur();
      void this.#update((event.target as HTMLInputElement).value.trim());
    }
  };

  @template()
  #render = () => {
    const { value, directories, loading, browseError } = this.#state;
    return html`
      <div class="px-5 pt-4 pb-5">
        <label class="block">
          <span class="mb-2 block text-[11px] font-bold tracking-[0.06em] text-describe uppercase">工作目录</span>
          <input
            class="box-border h-11 w-full rounded-[13px] border border-border bg-bg px-3.5 font-mono text-[12px] text-highlight outline-0 placeholder:text-disabled focus:border-primary"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            placeholder="/path/to/project"
            .value=${value}
            @input=${this.#onInput}
            @keydown=${this.#onKeydown}
          />
        </label>

        <div class="mt-3 max-h-[38vh] min-h-[128px] overflow-auto rounded-[15px] border border-border bg-bg-light/60">
          <div v-if=${loading} class="flex items-center justify-center gap-2 py-8 text-xs text-describe">
            <tap-use class="size-4 animate-spin" .element=${icons.loading}></tap-use>
            正在读取目录…
          </div>
          <div v-else-if=${browseError} class="px-4 py-6 text-center text-xs leading-relaxed text-negative">
            ${browseError}
          </div>
          <div v-else-if=${!directories.length} class="px-4 py-6 text-center text-xs text-describe">
            没有子目录，可以直接使用上方路径
          </div>
          ${directories.map(
            (directory) => html`
              <button
                class="flex w-full cursor-pointer items-center gap-2.5 border-0 border-b border-solid border-border/60 bg-transparent px-4 py-3 text-left font-mono text-[11px] text-text transition-colors last:border-b-0 active:bg-bg-hover"
                title=${directory}
                ?disabled=${this.creating}
                @click=${() => this.#enter(directory)}
              >
                <tap-use class="size-[15px] shrink-0 text-describe" .element=${icons.right}></tap-use>
                <span class="truncate">${displayPath(directory)}</span>
              </button>
            `,
          )}
        </div>

        <div
          v-if=${this.error}
          class="mt-3 rounded-[13px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-negative"
        >
          ${this.error}
        </div>

        <button
          class="mt-4 h-12 w-full cursor-pointer rounded-[15px] border-0 bg-primary text-sm font-bold text-white shadow-primary transition-transform active:scale-[0.985] disabled:cursor-default disabled:bg-border disabled:text-disabled disabled:shadow-none disabled:active:scale-100"
          ?disabled=${this.creating || !value.trim()}
          @click=${this.#confirm}
        >
          ${this.creating ? '正在创建会话…' : '在这里新建会话'}
        </button>
      </div>
    `;
  };
}
