import { Stack } from '@mantou/tap-ui/elements/stack';
import { icons } from '@mantou/tap-ui/lib/icons';
import { RELAY_GUIDE_SEEN_KEY } from '../config';
import { hardResetApp, saveSettings } from '../state/app';
import { agentdeckStore } from '../state/store';

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

  #state = createState({
    relayId: agentdeckStore.settings.relayId,
    agent: agentdeckStore.settings.agent,
    error: '',
    relayGuideOpen: !agentdeckStore.settings.relayId && !localStorage.getItem(RELAY_GUIDE_SEEN_KEY),
  });

  @effect((i) => [i.#state.relayGuideOpen])
  #rememberRelayGuide = () => {
    if (this.#state.relayGuideOpen) localStorage.setItem(RELAY_GUIDE_SEEN_KEY, 'true');
  };

  #closeRelayGuide = () => this.#state({ relayGuideOpen: false });

  #save = () => {
    try {
      saveSettings({ relayId: this.#state.relayId, agent: this.#state.agent });
      this.#state({ error: '' });
      if (this.canGoBack) {
        Stack.close();
      }
    } catch (error) {
      this.#state({ error: error instanceof Error ? error.message : '保存设置失败' });
    }
  };

  #reset = () => {
    try {
      hardResetApp();
    } catch (error) {
      this.#state({ error: error instanceof Error ? error.message : '重置失败' });
    }
  };

  @template()
  #render = () => {
    const { agents } = agentdeckStore;
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
            <h1 class="m-0 font-display text-base font-semibold text-highlight">设置</h1>
            <p class="mt-0.5 mb-0 text-xs text-describe">Relay 与远端 Agent</p>
          </div>
          <span></span>
        </header>

        <main class="settings-scroll no-scrollbar h-full overflow-auto px-4 pt-6">
          <div class="mx-auto w-full max-w-[560px]">
            <section class="mb-5 rounded-2xl border border-border bg-bg-light p-5">
              <div class="mb-4">
                <h2 class="m-0 font-display text-base font-semibold text-highlight">连接远端</h2>
                <p class="mt-1.5 mb-0 text-sm leading-relaxed text-describe">
                  填入 browser4agent 的 Relay ID，保存后自动连接。
                  <button
                    class="inline cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-primary-strong active:opacity-70"
                    @click=${() => this.#state({ relayGuideOpen: true })}
                  >如何获取 Relay ID？</button>
                </p>
              </div>

              <label class="block">
                <input
                  class="box-border h-12 w-full rounded-xl border border-border bg-bg px-3.5 font-mono text-base text-highlight outline-none placeholder:text-disabled"
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

            <section class="mb-5 rounded-2xl border border-border bg-bg-light p-5">
              <div class="mb-4">
                <h2 class="m-0 font-display text-base font-semibold text-highlight">远端 Agent</h2>
                <p class="mt-1.5 mb-0 text-sm leading-relaxed text-describe">
                  用于加载会话和执行任务。模式可在会话输入区切换。
                </p>
              </div>
              <label class="block">
                <span class="relative block">
                  <select
                    class="box-border h-12 w-full appearance-none rounded-xl border border-border bg-bg pr-11 pl-3.5 text-base font-medium text-highlight outline-none"
                    .value=${this.#state.agent}
                    @change=${(event: Event) =>
                      this.#state({ agent: (event.target as HTMLSelectElement).value, error: '' })}
                  >
                    ${agents.map(
                      (agent) =>
                        html`<option value=${agent.id} ?selected=${agent.id === this.#state.agent}>${agent.name}</option>`,
                    )}
                  </select>
                  <tap-use class="pointer-events-none absolute top-4 right-3.5 size-4 text-describe" .element=${icons.expand}></tap-use>
                </span>
              </label>
            </section>

            <div
              v-if=${this.#state.error}
              class="mb-3 rounded-[13px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2.5 text-sm text-negative"
            >
              ${this.#state.error}
            </div>
            <button
              class="h-12 w-full cursor-pointer rounded-xl border-0 bg-primary text-sm font-semibold text-white transition-transform active:scale-[0.985]"
              @click=${this.#save}
            >
              保存并连接
            </button>
            <button
              v-if=${!!agentdeckStore.settings.relayId}
              class="mt-3 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-bg-light text-sm font-semibold text-describe transition-colors active:bg-bg-hover"
              @click=${this.#reset}
            >
              重置 App
            </button>
            <p v-if=${!!agentdeckStore.settings.relayId} class="mt-2 mb-0 text-sm leading-relaxed text-describe">
              重新加载 App，清空本地会话缓存和未发送内容。保留配对设置与远端历史，远端任务可能仍在运行。
            </p>
          </div>
        </main>
      </tap-page>
      <deck-sheet
        ?open=${this.#state.relayGuideOpen}
        .heading=${'获取 Relay ID'}
        .description=${'在运行 Agent 的电脑上完成以下三步。'}
        @close=${this.#closeRelayGuide}
        .content=${html`
          <deck-relay-guide v-if=${this.#state.relayGuideOpen} @close=${this.#closeRelayGuide}></deck-relay-guide>
        `}
      ></deck-sheet>
    `;
  };
}
