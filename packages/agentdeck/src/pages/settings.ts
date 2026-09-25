import { Dialog } from '@mantou/tap-ui/elements/dialog';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { RELAY_GUIDE_SEEN_KEY } from '../config';
import type { DeckQrScannerError } from '../elements/qr-scanner';
import { i18n } from '../i18n';
import { hardResetApp, saveSettings } from '../state/app';
import { agentdeckStore } from '../state/store';
import { icons } from '../styles/icons';

const style = css`
  .settings-header {
    padding-top: calc(10px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
  }

  .settings-scroll {
    padding-bottom: calc(12px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }

  input[type='password'] {
    letter-spacing: 0.2em;
  }

  input::-ms-reveal,
  input::-ms-clear {
    display: none;
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
    relayGuideOpen: !agentdeckStore.settings.relayId && !localStorage.getItem(RELAY_GUIDE_SEEN_KEY),
    showRelayId: false,
  });

  @effect((i) => [i.#state.relayGuideOpen])
  #rememberRelayGuide = () => {
    if (this.#state.relayGuideOpen) localStorage.setItem(RELAY_GUIDE_SEEN_KEY, 'true');
  };

  #closeRelayGuide = () => this.#state({ relayGuideOpen: false });

  #openScanner = () => {
    Stack.push({
      content: html`
        <deck-qr-scanner
          .title=${i18n.get('settings.scanRelayId')}
          .hint=${i18n.get('settings.scanHint')}
          .cancelText=${i18n.get('global.cancel')}
          @result=${this.#handleScanResult}
          @cancel=${() => Stack.pop()}
          @error=${this.#handleScanError}
        ></deck-qr-scanner>
      `,
    });
  };

  #handleScanResult = async (event: CustomEvent<string>) => {
    Stack.pop();
    try {
      const url = new URL(event.detail);
      if (url.protocol !== 'agentdeck:') throw new Error();
      const relayId = url.searchParams.get('relayId');
      if (!relayId) throw new Error();
      this.#state({ relayId });
      Toast.open('success', i18n.get('settings.relayIdUpdated'));
    } catch {
      Toast.open('error', i18n.get('settings.scanFailed'));
    }
  };

  #handleScanError = (event: CustomEvent<DeckQrScannerError>) => {
    Stack.pop();
    Toast.open(
      'error',
      i18n.get(event.detail === 'permission-denied' ? 'settings.scanPermissionDenied' : 'settings.scanFailed'),
    );
  };

  #save = () => {
    try {
      saveSettings({ relayId: this.#state.relayId, agent: this.#state.agent });
      if (this.canGoBack) {
        Stack.pop();
      }
    } catch (error) {
      Toast.open('error', error instanceof Error ? error.message : i18n.get('settings.saveFailed'));
    }
  };

  #reset = async () => {
    await Dialog.confirm(i18n.get('settings.resetDesc'), {
      header: i18n.get('settings.resetApp'),
      dangerDefaultOkBtn: true,
    });
    try {
      hardResetApp();
    } catch (error) {
      Toast.open('error', error instanceof Error ? error.message : i18n.get('settings.resetFailed'));
    }
  };

  @template()
  #render = () => {
    const { agents } = agentdeckStore;
    return html`
      <tap-page class="bg-bg text-text" @hide=${() => this.#state({ showRelayId: false })}>
        <header
          slot="header"
          class="settings-header grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-border/80 bg-bg-light/90 px-3 pb-2.5 backdrop-blur-xl"
        >
          <button
            class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight active:scale-[0.94] active:bg-primary-soft disabled:invisible"
            ?disabled=${!this.canGoBack}
            aria-label=${i18n.get('settings.backAria')}
            @click=${() => Stack.pop()}
          >
            <tap-use class="size-[20px]" .element=${icons.back}></tap-use>
          </button>
          <div class="text-center">
            <h1 class="m-0 font-display text-base font-semibold text-highlight">${i18n.get('settings.title')}</h1>
            <p class="mt-0.5 mb-0 text-xs text-describe">${i18n.get('settings.subtitle')}</p>
          </div>
          <button
            type="button"
            class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight active:scale-[0.94] active:bg-primary-soft"
            aria-label=${i18n.get('settings.scanRelayId')}
            title=${i18n.get('settings.scanRelayId')}
            @click=${this.#openScanner}
          >
            <tap-use class="size-[20px]" .element=${icons.scan}></tap-use>
          </button>
        </header>

        <main class="settings-scroll no-scrollbar overflow-auto px-4 pt-6 mx-auto w-full max-w-[560px] min-h-full flex flex-col">
          <section class="mb-5 rounded-2xl border border-border bg-bg-light p-5">
            <div class="mb-4">
              <h2 class="m-0 font-display text-base font-semibold text-highlight">${i18n.get('settings.connectTitle')}</h2>
              <p class="mt-1.5 mb-0 text-sm leading-relaxed text-describe">
                ${i18n.get('settings.connectDesc')}
                <button
                  class="inline cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-primary-strong active:opacity-70"
                  @click=${() => this.#state({ relayGuideOpen: true })}
                >${i18n.get('settings.howToGetRelayId')}</button>
              </p>
            </div>

            <div class="relative block">
              <input
                type=${this.#state.showRelayId ? 'text' : 'password'}
                class="box-border h-12 w-full rounded-xl border border-border bg-bg pr-11 pl-3.5 outline-none placeholder:text-disabled ${
                  this.#state.showRelayId
                    ? 'font-mono text-base text-highlight tracking-normal'
                    : 'font-sans text-sm text-describe tracking-[0.2em]'
                }"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                aria-label=${i18n.get('settings.connectTitle')}
                .value=${this.#state.relayId}
                @input=${(event: InputEvent) => this.#state({ relayId: (event.target as HTMLInputElement).value })}
              />
              <button
                type="button"
                class="absolute top-0 right-0 grid h-12 w-11 cursor-pointer place-items-center border-0 bg-transparent text-describe transition-colors hover:text-highlight active:opacity-70"
                aria-label=${i18n.get(this.#state.showRelayId ? 'settings.hideRelayId' : 'settings.showRelayId')}
                title=${i18n.get(this.#state.showRelayId ? 'settings.hideRelayId' : 'settings.showRelayId')}
                @click=${(event: MouseEvent) => {
                  event.stopPropagation();
                  this.#state({ showRelayId: !this.#state.showRelayId });
                }}
              >
                <tap-use class="size-5" .element=${this.#state.showRelayId ? icons.visibilityOff : icons.visibility}></tap-use>
              </button>
            </div>
          </section>

          <section class="mb-5 rounded-2xl border border-border bg-bg-light p-5">
            <div class="mb-4">
              <h2 class="m-0 font-display text-base font-semibold text-highlight">${i18n.get('settings.agentTitle')}</h2>
              <p class="mt-1.5 mb-0 text-sm leading-relaxed text-describe">
                ${i18n.get('settings.agentDesc')}
              </p>
            </div>
            <label class="block">
              <span class="relative block">
                <select
                  class="box-border h-12 w-full appearance-none rounded-xl border border-border bg-bg pr-11 pl-3.5 text-base font-medium text-highlight outline-none"
                  .value=${this.#state.agent}
                  @change=${(event: Event) => this.#state({ agent: (event.target as HTMLSelectElement).value })}
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

          <div class="flex-1"></div>

          <button
            class="h-12 w-full cursor-pointer rounded-xl border-0 bg-primary text-sm font-semibold text-white transition-transform active:scale-[0.985]"
            @click=${this.#save}
          >
            ${i18n.get('settings.saveAndConnect')}
          </button>

          <button
            v-if=${!!agentdeckStore.settings.relayId}
            class="mt-3 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl text-sm font-semibold text-negative transition-colors"
            @click=${this.#reset}
          >
            ${i18n.get('settings.resetApp')}
          </button>
        </main>
      </tap-page>
      <deck-sheet
        ?open=${this.#state.relayGuideOpen}
        @close=${this.#closeRelayGuide}
        .content=${html`
          <deck-relay-guide @close=${this.#closeRelayGuide}></deck-relay-guide>
        `}
      ></deck-sheet>
    `;
  };
}
