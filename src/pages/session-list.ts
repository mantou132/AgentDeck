import { icons } from '@mantou/tap-ui/lib/icons';
import { getConnectionLabel, i18n } from '../i18n';
import { openSession, openSettings } from '../navigation';
import { createDraftSession, refreshSessions } from '../state/sessions';
import { agentdeckStore } from '../state/store';

const style = css`
  .menu-header {
    padding-top: calc(14px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
  }

  .menu-footer {
    padding-bottom: calc(12px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }

  .menu-scroll {
    padding-bottom: calc(28px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
`;

@customElement('agentdeck-session-list-page')
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class AgentDeckSessionListPageElement extends GemElement {
  #state = createState({
    sheetOpen: false,
    newSessionError: '',
    selectedCwd: '',
    navigatingCwd: false,
  });

  #openNewSession = () => {
    if (agentdeckStore.connection !== 'connected') return;
    this.#state({ sheetOpen: true, newSessionError: '', selectedCwd: '', navigatingCwd: true });
  };

  #closeNewSession = () => this.#state({ sheetOpen: false, newSessionError: '' });

  #onCwdChange = (event: CustomEvent<string>) => {
    this.#state({ selectedCwd: event.detail, navigatingCwd: false });
  };

  #onCwdNavStart = () => {
    this.#state({ navigatingCwd: true });
  };

  #confirmNewSession = () => {
    const { selectedCwd, navigatingCwd } = this.#state;
    if (!selectedCwd || navigatingCwd) return;
    const session = createDraftSession({ agent: agentdeckStore.settings.agent, cwd: selectedCwd });
    this.#state({ sheetOpen: false, newSessionError: '' });
    openSession(session.sessionId);
  };

  @template()
  #render = () => {
    const { sheetOpen, newSessionError, selectedCwd, navigatingCwd } = this.#state;
    const {
      sessionGroups,
      connection,
      connectionError,
      sessionsLoading,
      sessionsLoaded,
      sessionsError,
      settings,
      agents,
    } = agentdeckStore;
    const selectedAgent = agents.find((agent) => agent.id === settings.agent);
    const errorMessage = connectionError || sessionsError;
    const hasError = Boolean(errorMessage);
    const hasGroups = Boolean(sessionGroups.length);
    const showSkeleton = !hasGroups && (sessionsLoading || !sessionsLoaded) && !hasError;
    const showErrorState = !showSkeleton && !hasGroups && hasError;

    const isConnected = connection === 'connected';
    const isConnecting = connection === 'connecting' || connection === 'reconnecting' || connection === 'attaching';

    return html`
      <tap-page class="bg-bg text-text">
        <header
          slot="header"
          class="menu-header flex items-center gap-4 bg-bg/90 px-5 pb-3.5 backdrop-blur-xl backdrop-saturate-125 min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[620px]"
        >
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <img class="size-11 shrink-0 rounded-[13px] shadow-card" src="/agentdeck-icon.png" alt="" />
            <div class="min-w-0 flex-1">
              <h1 class="m-0 font-display text-xl font-bold leading-none tracking-[-0.025em] text-highlight">
                AgentDeck
              </h1>
              <div class="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs font-semibold text-describe">
                <span
                  class=${classMap({
                    'size-[7px] shrink-0 rounded-full bg-disabled': true,
                    'bg-positive ring-4 ring-positive/10': isConnected,
                    'bg-negative ring-4 ring-negative/10': connection === 'preempted',
                    'animate-pulse bg-informative': isConnecting,
                  })}
                ></span>
                <span class="truncate">${getConnectionLabel(connection)} · ${selectedAgent?.name || settings.agent}</span>
              </div>
            </div>
          </div>
        </header>

        <main
          class="menu-scroll no-scrollbar h-full overflow-auto px-4 pt-2 overscroll-y-contain min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[620px]"
        >
          <div
            v-if=${hasGroups && hasError}
            class="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-negative/20 bg-negative/[0.06] px-4 py-3 text-xs leading-relaxed text-negative"
          >
            <div class="flex min-w-0 items-center gap-2">
              <tap-use class="size-4 shrink-0" .element=${icons.error}></tap-use>
              <span class="truncate">${errorMessage}</span>
            </div>
            <button
              class="shrink-0 cursor-pointer font-semibold underline underline-offset-2"
              @click=${() => refreshSessions()}
            >
              ${isConnected ? i18n.get('global.reload') : i18n.get('global.reconnect')}
            </button>
          </div>

          <div v-if=${showSkeleton} class="flex flex-col gap-5" aria-label=${i18n.get('sessionList.loading')}>
            ${[3, 2].map(
              (rows) => html`
                <section class="overflow-hidden rounded-[20px] border border-border bg-bg-light shadow-card">
                  <div class="flex h-[44px] items-center gap-2 border-b border-border px-4">
                    <span class="h-2.5 w-28 animate-pulse rounded-full bg-border"></span>
                    <span class="ml-auto h-5 w-7 animate-pulse rounded-lg bg-primary-soft"></span>
                  </div>
                  ${Array.from(
                    { length: rows },
                    () => html`
                      <div class="border-b border-border/70 px-4 py-4 last:border-0">
                        <span class="block h-3.5 w-[68%] animate-pulse rounded-full bg-border"></span>
                        <span class="mt-2.5 block h-2.5 w-[38%] animate-pulse rounded-full bg-primary-soft"></span>
                      </div>
                    `,
                  )}
                </section>
              `,
            )}
          </div>

          <div v-if=${hasGroups} class="flex flex-col gap-5 pt-2">
            ${sessionGroups.map(
              (group) => html`
                <deck-session-group
                  .cwd=${group.cwd}
                  .sessions=${group.sessions}
                  .unreadSessionIds=${agentdeckStore.unreadSessionIds}
                  .pendingSessionIds=${agentdeckStore.pendingSessionIds}
                  @select=${(event: CustomEvent<string>) => openSession(event.detail)}
                ></deck-session-group>
              `,
            )}
          </div>

          <section
            v-if=${showErrorState}
            class="grid h-full min-h-[60vh] place-items-center content-center px-6 py-8 text-center"
          >
            <div
              class="grid size-16 place-items-center rounded-2xl border border-negative/20 bg-negative/[0.08] text-negative shadow-card"
            >
              <tap-use class="size-7" .element=${icons.error}></tap-use>
            </div>
            <h2 class="mt-5 mb-2 font-display text-lg font-bold tracking-tight text-highlight">
              ${i18n.get('sessionList.errorTitle')}
            </h2>
            <p class="m-0 max-w-[340px] text-xs leading-relaxed text-describe">
              ${errorMessage}
            </p>
            <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                class="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-5 text-xs font-semibold text-white shadow-primary transition-transform active:scale-95"
                @click=${() => refreshSessions()}
              >
                ${isConnected ? i18n.get('global.reload') : i18n.get('global.reconnect')}
              </button>
              <button
                class="flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-light px-4 text-xs font-semibold text-highlight shadow-card transition-transform active:scale-95"
                @click=${openSettings}
              >
                <tap-use class="size-3.5 text-describe" .element=${icons.tune}></tap-use>
                ${i18n.get('global.openSettings')}
              </button>
            </div>
          </section>

          <section
            v-if=${!showSkeleton && !hasGroups && !hasError}
            class="mt-16 grid place-items-center px-8 py-10 text-center"
          >
            <div class="grid size-14 place-items-center rounded-[18px] border border-border bg-bg-light shadow-card">
              <tap-use class="size-6 text-describe" .element=${icons.menu}></tap-use>
            </div>
            <h2 class="mt-4 mb-1.5 font-display text-lg font-semibold text-highlight">
              ${i18n.get('sessionList.emptyTitle')}
            </h2>
            <p class="m-0 max-w-[320px] text-sm leading-relaxed text-describe">
              ${i18n.get('sessionList.emptyDesc')}
            </p>
          </section>
        </main>

        <footer
          v-if=${!showErrorState && !showSkeleton}
          slot="footer"
          class="menu-footer bg-bg/90 px-4 pt-2.5 backdrop-blur-xl backdrop-saturate-125 min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[620px]"
        >
          <div class="flex items-center justify-between gap-3">
            <button
              class="flex h-12 min-w-0 px-4 cursor-pointer items-center justify-center gap-2 rounded-[15px] border-0 bg-primary text-sm font-bold text-white shadow-primary transition-transform active:scale-[0.985] disabled:cursor-default disabled:opacity-45"
              ?disabled=${connection !== 'connected'}
              @click=${this.#openNewSession}
            >
              <tap-use class="size-[18px]" .element=${icons.add}></tap-use>
              ${i18n.get('sessionList.newSession')}
            </button>
            <button
              class="grid size-12 shrink-0 cursor-pointer place-items-center rounded-[15px] border border-border bg-bg-light text-highlight shadow-card transition-[transform,background-color] duration-150 active:scale-[0.94] active:bg-bg-hover"
              aria-label=${i18n.get('sessionList.openSettingsAria')}
              @click=${openSettings}
            >
              <tap-use class="size-[20px]" .element=${icons.tune}></tap-use>
            </button>
          </div>
        </footer>
      </tap-page>
      <deck-sheet
        ?open=${sheetOpen}
        .heading=${i18n.get('sessionList.newSessionHeading')}
        .description=${i18n.get('sessionList.newSessionDesc')}
        @close=${this.#closeNewSession}
        .content=${html`
          <div v-if=${sheetOpen} class="w-full">
            <deck-file-browser
              directories-only
              .emptyText=${i18n.get('cwdPicker.emptyDir')}
              @navstart=${this.#onCwdNavStart}
              @change=${this.#onCwdChange}
            ></deck-file-browser>

            <div
              v-if=${newSessionError}
              class="mt-3 rounded-[13px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2.5 text-sm leading-relaxed text-negative"
            >
              ${newSessionError}
            </div>

            <button
              type="button"
              class="mt-4 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-0 bg-primary px-4 text-sm font-semibold text-white transition-transform active:scale-[0.985] disabled:cursor-default disabled:bg-border disabled:text-disabled disabled:shadow-none disabled:active:scale-100"
              ?disabled=${navigatingCwd || !selectedCwd}
              @click=${this.#confirmNewSession}
            >
              <span>${i18n.get('cwdPicker.createHere')}</span>
            </button>
          </div>
        `}
      ></deck-sheet>
    `;
  };
}
