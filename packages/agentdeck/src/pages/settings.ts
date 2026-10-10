import { Dialog } from '@mantou/tap-ui/elements/dialog';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FEEDBACK_URL, isRelayUrl, RELAY_GUIDE_SEEN_KEY } from '../config';
import type { DeckQrScannerError } from '../elements/qr-scanner';
import { i18n } from '../i18n';
import { hardResetApp, removePairing, saveSettings } from '../state/app';
import { agentdeckStore } from '../state/store';
import { icons } from '../styles/icons';

const style = css`
  .settings-header {
    padding-top: max(6px, var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
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
    relayUrl: agentdeckStore.settings.relayUrl,
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
      const pairingId = url.searchParams.get('pairingId');
      const relayUrl = url.searchParams.get('relayUrl') || '';
      if (!pairingId || (relayUrl && !isRelayUrl(relayUrl))) throw new Error();
      this.#state({ relayId: pairingId, relayUrl });
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

  #fillPairing = (relayId: string, relayUrl = '') => {
    this.#state({ relayId, relayUrl });
    Toast.open('success', i18n.get('settings.relayIdUpdated'));
  };

  #save = () => {
    try {
      saveSettings({ relayId: this.#state.relayId, agent: this.#state.agent, relayUrl: this.#state.relayUrl });
      if (this.canGoBack) {
        Stack.pop();
      }
    } catch (error) {
      Toast.open('error', error instanceof Error ? error.message : i18n.get('settings.saveFailed'));
    }
  };

  #openFeedback = async () => {
    const platform = /Android/i.test(navigator.userAgent)
      ? 'Android'
      : /iPhone|iPad/i.test(navigator.userAgent)
        ? 'iOS'
        : navigator.platform;
    const env = [
      `- App: ${isTauri() ? await getVersion() : 'web'}`,
      `- Platform: ${platform}`,
      `- Daemon: ${agentdeckStore.hostVersion || 'unknown'}`,
    ];
    const url = `${FEEDBACK_URL}?body=${encodeURIComponent(`\n\n---\n${env.join('\n')}\n`)}`;
    if (isTauri()) {
      await openUrl(url);
    } else {
      window.open(url, '_blank');
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
    const pairings = agentdeckStore.pairingHistory.filter((item) => item.relayId !== this.#state.relayId.trim());
    return html`
      <tap-page class="bg-bg text-text" @hide=${() => this.#state({ showRelayId: false })}>
        <header
          slot="header"
          class="settings-header grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-border-strong px-3 pb-1.5"
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
            v-if=${isTauri()}
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
                class="box-border h-12 w-full rounded-xl border border-border-strong bg-bg pr-11 pl-3.5 outline-none placeholder:text-disabled ${
                  this.#state.showRelayId
                    ? 'font-mono text-base text-highlight tracking-normal'
                    : 'font-sans text-sm text-describe tracking-[0.2em]'
                }"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                placeholder="adk1_..."
                aria-label=${i18n.get('settings.connectTitle')}
                .value=${this.#state.relayId}
                @input=${(event: InputEvent) =>
                  // Relay URL only comes from a scanned QR code; manual edits fall back to the default relay.
                  this.#state({ relayId: (event.target as HTMLInputElement).value, relayUrl: '' })}
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

            <div v-if=${pairings.length > 0} class="mt-4">
              <p class="mt-0 mb-2 text-xs font-medium text-describe">${i18n.get('settings.recentPairings')}</p>
              <div class="flex flex-col gap-2">
                ${pairings.map(
                  ({ relayId, relayUrl, hostname }) => html`
                    <div class="flex h-12 items-center rounded-xl border border-border bg-bg">
                      <button
                        type="button"
                        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent pl-3.5 text-left active:opacity-70"
                        @click=${() => this.#fillPairing(relayId, relayUrl)}
                      >
                        <span class="truncate text-sm font-medium text-highlight">
                          ${hostname || i18n.get('settings.unknownHost')}
                        </span>
                        <span class="shrink-0 font-mono text-xs text-describe">…${relayId.slice(-4)}</span>
                      </button>
                      <button
                        type="button"
                        class="grid h-12 w-11 shrink-0 cursor-pointer place-items-center border-0 bg-transparent text-describe transition-colors hover:text-highlight active:opacity-70"
                        aria-label=${i18n.get('settings.removePairingAria')}
                        @click=${() => removePairing(relayId)}
                      >
                        <tap-use class="size-4" .element=${icons.close}></tap-use>
                      </button>
                    </div>
                  `,
                )}
              </div>
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
                  class="box-border h-12 w-full appearance-none rounded-xl border border-border-strong bg-bg pr-11 pl-3.5 text-base font-medium text-highlight outline-none"
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

          <div class="mt-3 flex h-10 items-center justify-center gap-2 text-xs text-describe">
            <button
              type="button"
              class="h-full cursor-pointer border-0 bg-transparent p-0 text-xs text-describe active:opacity-70"
              @click=${this.#openFeedback}
            >${i18n.get('settings.feedback')}</button>
            <span v-if=${!!agentdeckStore.settings.relayId}>·</span>
            <button
              type="button"
              v-if=${!!agentdeckStore.settings.relayId}
              class="h-full cursor-pointer border-0 bg-transparent p-0 text-xs text-describe active:opacity-70"
              @click=${this.#reset}
            >${i18n.get('settings.resetApp')}</button>
          </div>
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
