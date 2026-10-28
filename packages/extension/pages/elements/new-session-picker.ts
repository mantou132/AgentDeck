import type { Emitter } from '@mantou/gem/lib/decorators';
import type { AgentInfo } from 'agentdeck/config';
import { displayPath } from 'agentdeck/lib/path';
import { hotkeys } from 'duoyun-ui/lib/hotkeys';
import { t } from '../../shared/i18n';

export type NewSessionChoice = { agent: string; cwd: string };

type CwdCompletion = { directories: string[]; value?: string; isDirectory?: boolean };

@customElement('agent-new-session-picker')
export class AgentNewSessionPickerElement extends GemElement {
  @property complete?: (value: string) => Promise<CwdCompletion>;
  @property initialValue = '';
  @property home = '';
  @property agents: AgentInfo[] = [];
  @property initialAgent = '';

  @emitter confirm: Emitter<NewSessionChoice>;

  #s = createState({
    value: '',
    directories: [] as string[],
    loading: true,
    error: '',
    activeIndex: 0,
    agent: '',
  });
  #activeDirectoryRef = createRef<HTMLButtonElement>();

  @willMount()
  #init = () => {
    const { agents } = this;
    const agent = agents.some((item) => item.id === this.initialAgent) ? this.initialAgent : agents[0]?.id || '';
    this.#s({ agent });
    this.#update(this.#directoryInput(this.initialValue));
  };

  @effect((i) => [i.#s.activeIndex, i.#s.directories])
  #scrollActive = () => {
    this.#activeDirectoryRef.value?.scrollIntoView({ block: 'nearest' });
  };

  #update = async (value: string) => {
    this.#s({
      value,
      directories: [],
      loading: true,
      error: '',
      activeIndex: 0,
    });
    try {
      const result = await this.complete?.(value);
      const directories = [...(result?.directories || [])];
      if (result?.isDirectory && result.value) {
        directories.unshift(result.value);
      }
      this.#s({
        value: value || this.#directoryInput(result?.value),
        directories,
        loading: false,
      });
    } catch (err) {
      this.#s({ directories: [], loading: false, error: err.message });
    }
  };

  #directoryInput = (value = '') => {
    const display = displayPath(value, this.home);
    if (!display || display === '/') return display;
    return `${display.replace(/[\\/]+$/, '')}/`;
  };

  #select = (value: string) => {
    this.#update(this.#directoryInput(value));
  };

  #confirm = (cwd: string) => {
    if (this.#s.agent) this.confirm({ agent: this.#s.agent, cwd });
  };

  #onKeydown = hotkeys(
    {
      tab: () => {
        const { directories, activeIndex } = this.#s;
        if (directories[activeIndex]) this.#select(directories[activeIndex]);
      },
      down: () => {
        const { directories, activeIndex } = this.#s;
        if (directories.length) this.#s({ activeIndex: (activeIndex + 1) % directories.length });
      },
      up: () => {
        const { directories, activeIndex } = this.#s;
        if (directories.length) this.#s({ activeIndex: (activeIndex - 1 + directories.length) % directories.length });
      },
      enter: () => {
        const { directories, activeIndex } = this.#s;
        if (directories[activeIndex]) this.#confirm(directories[activeIndex]);
      },
    },
    { stopPropagation: true },
  );

  @template()
  #content = () => {
    const { value, directories, loading, error, activeIndex, agent } = this.#s;
    const agentOptions = this.agents.map((item) => ({
      label: html`
        <agent-option-label .agent=${item.id} .name=${item.name}></agent-option-label>
      `,
      value: item.id,
    }));

    return html`
      <section class="w-full rounded-lg border border-border bg-bg shadow-lg">
        <header class="border-b border-border px-4 py-3">
          <h2 class="m-0 text-sm font-semibold text-highlight">${t('devtoolsNewSessionTitle')}</h2>
        </header>
        <div class="px-4 py-3">
          <div class="mb-3">
            <label class="mb-1.5 block text-xs font-medium text-describe" for="agent-new-session-agent-select">
              ${t('devtoolsAgentLabel')}
            </label>
            <dy-select
              id="agent-new-session-agent-select"
              class="w-full"
              .value=${agent}
              .options=${agentOptions}
              @change=${(e: CustomEvent<string>) => this.#s({ agent: e.detail })}
            ></dy-select>
          </div>
          <label class="mb-1.5 block text-xs font-medium text-describe" for="agent-new-session-cwd-input">
            ${t('devtoolsCwdTitle')}
          </label>
          <dy-input
            id="agent-new-session-cwd-input"
            autofocus
            class="w-full font-mono"
            placeholder=${t('devtoolsCwdPlaceholder')}
            .value=${value}
            @change=${(e: CustomEvent<string>) => this.#update(e.detail)}
            @keydown=${this.#onKeydown}
          ></dy-input>
          <div class="mt-2 h-52 overflow-auto rounded border border-border bg-bg-light/40">
            <div v-if=${loading} class="grid h-full place-items-center text-describe"><dy-loading></dy-loading></div>
            <div v-if=${!loading && !directories.length} class="grid h-full place-items-center text-xs text-describe">
              ${t('devtoolsCwdNoDirectories')}
            </div>
            ${directories.map(
              (directory, index) => html`
                <button
                  ${index === activeIndex ? this.#activeDirectoryRef : undefined}
                  type="button"
                  aria-current=${index === activeIndex}
                  class=${classMap({
                    'block w-full truncate border-0 border-b border-border px-3 py-2 text-left font-mono text-xs text-text': true,
                    'bg-bg-hover font-medium': index === activeIndex,
                    'bg-transparent': index !== activeIndex,
                    'cursor-pointer hover:bg-bg-hover': true,
                  })}
                  title=${directory}
                  @click=${() => this.#confirm(directory)}
                >
                  ${displayPath(directory, this.home)}
                </button>
              `,
            )}
          </div>
          <div v-if=${error} class="mt-2 text-xs text-negative">${error}</div>
        </div>
      </section>
    `;
  };
}
