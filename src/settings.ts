import { Stack } from '@mantou/tap-ui/elements/stack';
import { icons } from '@mantou/tap-ui/lib/icons';

import { agentdeckStore, saveSettings } from './session-store';

const style = css`
  .settings-header {
    padding-top: calc(10px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
  }

  .settings-scroll {
    padding-bottom: calc(32px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
`;

@customElement('agentdeck-settings-page')
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class AgentDeckSettingsPageElement extends GemElement {
  @property canGoBack = false;
  @property onDone?: () => void;

  #state = createState({
    relayId: agentdeckStore.settings.relayId,
    agent: agentdeckStore.settings.agent,
    error: '',
  });

  #save = () => {
    try {
      saveSettings({ relayId: this.#state.relayId, agent: this.#state.agent });
      this.#state({ error: '' });
      this.onDone?.();
    } catch (error) {
      this.#state({ error: error instanceof Error ? error.message : '保存设置失败' });
    }
  };

  @template()
  #render = () => {
    const { agents, connection, connectionError } = agentdeckStore;
    return html`
      <tap-page class="bg-bg text-text">
        <header
          slot="header"
          class="settings-header grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-border/80 bg-bg-light/90 px-3 pb-2.5 backdrop-blur-xl"
        >
          <button
            class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight active:scale-[0.94] active:bg-primary-soft disabled:invisible"
            ?disabled=${!this.canGoBack}
            aria-label="返回"
            @click=${() => Stack.close()}
          >
            <tap-use class="size-[20px]" .element=${icons.back}></tap-use>
          </button>
          <div class="text-center">
            <h1 class="m-0 font-display text-[17px] font-[720] text-highlight">设置</h1>
            <p class="mt-0.5 mb-0 text-[10px] text-describe">Relay 与远端 Agent</p>
          </div>
          <span></span>
        </header>

        <main class="settings-scroll no-scrollbar h-full overflow-auto px-4 pt-6">
          <div class="mx-auto w-full max-w-[560px]">
            <section class="mb-5 rounded-[22px] border border-border bg-bg-light p-5 shadow-card">
              <div class="mb-5 flex items-start gap-3.5">
                <div class="grid size-11 shrink-0 place-items-center rounded-[14px] bg-primary-soft text-primary-strong">
                  <tap-use class="size-5" .element=${icons.outward}></tap-use>
                </div>
                <div>
                  <h2 class="m-0 font-display text-base font-[720] text-highlight">连接远端</h2>
                  <p class="mt-1 mb-0 text-xs leading-relaxed text-describe">
                    Relay ID 是这台 App 与 browser4agent 的配对凭据。保存后会自动建立 WebSocket 连接。
                  </p>
                </div>
              </div>

              <label class="block">
                <span class="mb-2 block text-[11px] font-bold tracking-[0.06em] text-describe uppercase">Relay ID</span>
                <input
                  class="box-border h-12 w-full rounded-[14px] border border-border bg-bg px-3.5 font-mono text-[12px] text-highlight outline-0 placeholder:text-disabled focus:border-primary"
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck="false"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  .value=${this.#state.relayId}
                  @input=${(event: InputEvent) =>
                    this.#state({ relayId: (event.target as HTMLInputElement).value, error: '' })}
                />
              </label>
            </section>

            <section class="mb-5 rounded-[22px] border border-border bg-bg-light p-5 shadow-card">
              <div class="mb-4">
                <h2 class="m-0 font-display text-base font-[720] text-highlight">远端 Agent</h2>
                <p class="mt-1 mb-0 text-xs leading-relaxed text-describe">
                  会话列表与新消息都交给这个 ACP Agent。Mode、model 和其他 option 暂时沿用 ACP 默认值。
                </p>
              </div>
              <label class="block">
                <span class="mb-2 block text-[11px] font-bold tracking-[0.06em] text-describe uppercase">Agent</span>
                <select
                  class="box-border h-12 w-full appearance-none rounded-[14px] border border-border bg-bg px-3.5 text-sm font-semibold text-highlight outline-0 focus:border-primary"
                  .value=${this.#state.agent}
                  @change=${(event: Event) =>
                    this.#state({ agent: (event.target as HTMLSelectElement).value, error: '' })}
                >
                  ${agents.map(
                    (agent) =>
                      html`<option value=${agent.id} ?selected=${agent.id === this.#state.agent}>${agent.name}</option>`,
                  )}
                </select>
              </label>
            </section>

            <section class="mb-5 flex items-center gap-3 rounded-[17px] border border-border bg-bg-light/70 px-4 py-3.5">
              <span
                class=${classMap({
                  'size-2.5 shrink-0 rounded-full bg-disabled': true,
                  'bg-positive ring-4 ring-positive/10': connection === 'connected',
                  'animate-pulse bg-informative': connection === 'connecting' || connection === 'reconnecting',
                  'bg-negative ring-4 ring-negative/10': connection === 'preempted',
                })}
              ></span>
              <span class="min-w-0">
                <span class="block text-xs font-semibold text-highlight">
                  ${connection === 'connected' ? 'Relay 已连接' : '保存后自动连接'}
                </span>
                <span v-if=${connectionError} class="mt-0.5 block truncate text-[10px] text-negative">
                  ${connectionError}
                </span>
              </span>
            </section>

            <div
              v-if=${this.#state.error}
              class="mb-3 rounded-[13px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2.5 text-xs text-negative"
            >
              ${this.#state.error}
            </div>
            <button
              class="h-12 w-full cursor-pointer rounded-[15px] border-0 bg-primary text-sm font-bold text-white shadow-primary transition-transform active:scale-[0.985]"
              @click=${this.#save}
            >
              保存并连接
            </button>
          </div>
        </main>
      </tap-page>
    `;
  };
}
