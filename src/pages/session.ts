import { history } from '@mantou/gem/lib/history';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { icons } from '@mantou/tap-ui/lib/icons';
import { reconnectTransport } from '../agent/transport';
import type { ComposerInput, DeckComposerElement } from '../elements/composer';
import { getConnectionLabel, i18n } from '../i18n';
import { displayPath } from '../lib/path';
import { openSettings } from '../navigation';
import { getModeSelection } from '../session/modes';
import type { Attachment, TextMessage } from '../session/types';
import { changeSessionMode } from '../state/modes';
import {
  cancelTurn,
  ensureSessionLoaded,
  getSession,
  promoteDraftSession,
  resetDraftSession,
  resolvePermission,
  retrySessionLoad,
  sendPrompt,
} from '../state/sessions';
import { agentdeckStore, clearSessionError, setSessionFlag } from '../state/store';

const style = css`
  .session-header {
    min-height: calc(62px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
    padding-top: calc(10px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
  }
`;

@customElement('agentdeck-session-page')
@adoptedStyle(style)
@connectStore(agentdeckStore)
@connectStore(history.store)
export class AgentDeckSessionPageElement extends GemElement {
  @property sessionId = '';

  #state = createState({ previewAttachment: null as Attachment | null, followMessages: true, canRestoreInput: true });
  #messagesRef = createRef<HTMLElement>();
  #messagesContentRef = createRef<HTMLElement>();
  #composerRef = createRef<DeckComposerElement>();
  #scrollFrame = 0;

  #markRead = () => {
    if (
      this.isConnected &&
      document.visibilityState === 'visible' &&
      Stack.inCurrentStack(this) &&
      agentdeckStore.unreadSessionIds.includes(this.sessionId)
    ) {
      setSessionFlag('unreadSessionIds', this.sessionId, false);
    }
  };

  @effect((instance) => [instance.sessionId, agentdeckStore.unreadSessionIds, history.store])
  #readCompletedResponse = () => queueMicrotask(this.#markRead);

  @effect(() => [])
  #watchVisibility = () => {
    document.addEventListener('visibilitychange', this.#markRead);
    return () => document.removeEventListener('visibilitychange', this.#markRead);
  };

  @effect((instance) => [instance.sessionId])
  #openSession = () => {
    this.#state({ previewAttachment: null });
    void ensureSessionLoaded(this.sessionId);
    queueMicrotask(this.#scrollToLatest);
  };

  @effect((instance) => [instance.#messagesRef.value, instance.#messagesContentRef.value])
  #watchMessageSize = () => {
    const viewport = this.#messagesRef.value;
    const content = this.#messagesContentRef.value;
    if (!viewport || !content) return;
    // Markdown/images can finish rendering after the session state update.
    const observer = new ResizeObserver(this.#scrollToLatest);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  };

  @unmounted()
  #cleanupFrame = () => {
    cancelAnimationFrame(this.#scrollFrame);
    if (this.sessionId === 'draft') {
      resetDraftSession();
    }
  };

  #onScroll = () => {
    const element = this.#messagesRef.value;
    if (!element) return;
    const followMessages = element.scrollHeight - element.clientHeight - element.scrollTop <= 4;
    if (followMessages === this.#state.followMessages) return;
    if (!followMessages) cancelAnimationFrame(this.#scrollFrame);
    this.#state({ followMessages });
  };

  #resumeFollowing = () => {
    this.#state({ followMessages: true });
    this.#scrollToLatest();
  };

  #scrollToLatest = () => {
    if (!this.#state.followMessages) return;
    cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = requestAnimationFrame(() => {
      const element = this.#messagesRef.value;
      if (element) element.scrollTop = element.scrollHeight;
    });
  };

  #send = async ({ text, attachments }: ComposerInput) => {
    const session = getSession(this.sessionId);
    if (!session) return false;
    if (!session.draft) return sendPrompt(this.sessionId, text, attachments);
    const liveSession = await promoteDraftSession(session, text, attachments);
    if (!liveSession) return false;
    this.sessionId = liveSession.sessionId;
    return true;
  };

  #previewAttachment = (event: CustomEvent<Attachment>) => {
    this.#state({ previewAttachment: event.detail });
  };

  #retryLoad = () => {
    void retrySessionLoad(this.sessionId);
  };

  #renderHeader = (title: string, cwd?: string, loading = false, loaded = false) => {
    const connected = agentdeckStore.connection === 'connected';
    return html`
      <header
        slot="header"
        class="session-header relative grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-border/80 bg-bg-light/90 px-3 pb-2.5 backdrop-blur-xl backdrop-saturate-125"
      >
        <button
          class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight transition-[transform,background-color] duration-150 active:scale-[0.94] active:bg-primary-soft"
          aria-label=${i18n.get('session.backAria')}
          @click=${() => Stack.close()}
        >
          <tap-use class="size-[20px]" .element=${icons.back}></tap-use>
        </button>
        <div class="min-w-0 text-center">
          <div class="truncate font-display text-base leading-tight font-semibold text-highlight">${title}</div>
          <div v-if=${cwd} class="mt-1 flex min-w-0 items-center justify-center gap-1.5 text-sm font-medium text-describe">
            <span
              class=${classMap({
                'size-1.5 shrink-0 rounded-full': true,
                'bg-positive': connected && loaded,
                'animate-pulse bg-informative': loading,
                'bg-disabled': !connected || (!loaded && !loading),
              })}
            ></span>
            <span class="truncate font-mono">${displayPath(cwd || '')}</span>
          </div>
        </div>
        <button
          class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight active:scale-[0.94] active:bg-primary-soft"
          aria-label=${i18n.get('session.openSettingsAria')}
          @click=${openSettings}
        >
          <tap-use class="size-[20px]" .element=${icons.tune}></tap-use>
        </button>
      </header>
    `;
  };

  @template()
  #render = () => {
    const session = getSession(this.sessionId);
    if (!session) {
      return html`
        <tap-page class="bg-bg text-text">
          ${this.#renderHeader(i18n.get('session.unavailableTitle'))}
          <main class="grid h-full place-items-center content-center px-6 text-center">
            <h2 class="m-0 font-display text-lg font-semibold text-highlight">${i18n.get('session.notFound')}</h2>
            <p class="mt-2 mb-4 max-w-[320px] text-sm leading-relaxed text-describe">
              ${i18n.get('session.notFoundDesc')}
            </p>
            <button
              class="cursor-pointer rounded-xl border border-primary/20 bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary-strong active:scale-[0.98]"
              @click=${openSettings}
            >
              ${i18n.get('global.openSettings')}
            </button>
          </main>
        </tap-page>
      `;
    }
    const messages = agentdeckStore.messagesBySession[session.sessionId] ?? [];
    const loading = agentdeckStore.loadingSessionIds.includes(session.sessionId);
    const loaded = agentdeckStore.loadedSessionIds.includes(session.sessionId);
    const pending = agentdeckStore.pendingSessionIds.includes(session.sessionId);
    const changingMode = agentdeckStore.changingModeSessionIds.includes(session.sessionId);
    const error =
      agentdeckStore.errorsBySession[session.sessionId] ||
      agentdeckStore.connectionError ||
      (!loaded && !loading ? i18n.get('session.notLoaded') : '');
    const connected = agentdeckStore.connection === 'connected';
    return html`
      <tap-page class="bg-bg text-text">
        ${this.#renderHeader(session.title || (session.draft ? i18n.get('session.newTitle') : i18n.get('session.untitled')), session.cwd, loading, loaded)}

        <div class="relative h-full">
          <main
            ${this.#messagesRef}
            class="no-scrollbar h-full overflow-x-hidden overflow-y-auto px-4 pt-[22px] pb-7 overscroll-y-contain sm:px-6"
            tabindex="0"
            aria-label=${i18n.get('session.messagesAria')}
            @scroll=${this.#onScroll}
          >
            <div ${this.#messagesContentRef} class="mx-auto min-h-full w-full max-w-[720px]">
              <section v-if=${loading} class="grid min-h-full place-items-center content-center px-6 py-12 text-center">
                <div class="grid size-14 place-items-center rounded-[18px] border border-border bg-bg-light shadow-card">
                  <tap-use class="size-6 text-primary" .element=${icons.loading}></tap-use>
                </div>
                <h2 class="mt-4 mb-1.5 font-display text-lg font-semibold text-highlight">${i18n.get('session.loadingTitle')}</h2>
                <p class="m-0 text-sm text-describe">${i18n.get('session.loadingDesc')}</p>
              </section>
              <div v-if=${!loading && !!messages.length} class="contents">
                <deck-session-timeline
                  .sessionKey=${this.sessionId}
                  .cwd=${session.cwd}
                  .messages=${messages}
                  ?pending=${pending}
                  ?can-restore-input=${this.#state.canRestoreInput}
                  @restore=${(event: CustomEvent<TextMessage>) => this.#composerRef.value?.restore(event.detail)}
                  @preview=${this.#previewAttachment}
                ></deck-session-timeline>
              </div>
              <section
                v-if=${!loading && loaded && !messages.length}
                class="grid min-h-full place-items-center content-center px-5 py-8 text-center"
              >
                <div class="grid size-[54px] place-items-center rounded-[18px] border border-border bg-bg-light shadow-float">
                  <deck-icon></deck-icon>
                </div>
                <h2 class="mt-[18px] mb-2 font-display text-lg font-semibold tracking-[-0.02em] text-highlight">
                  ${session.draft ? i18n.get('session.newSession') : i18n.get('session.ready')}
                </h2>
                <p class="m-0 max-w-[280px] text-sm leading-relaxed text-describe">
                  ${session.draft ? i18n.get('session.newSessionHint') : i18n.get('session.emptyHistoryHint')}
                </p>
              </section>
            </div>
          </main>
          <button
            v-if=${!this.#state.followMessages}
            type="button"
            class="absolute bottom-3 left-1/2 flex min-h-10 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-primary/20 bg-bg-light px-3.5 text-sm font-semibold whitespace-nowrap text-primary-strong shadow-float active:bg-primary-soft"
            @click=${this.#resumeFollowing}
          >
            <tap-use class="size-4" .element=${icons.expand}></tap-use>
            ${i18n.get('session.scrollToLatest')}
          </button>
        </div>

        <footer slot="footer">
          <div
            v-if=${error}
            class="mx-3 mb-2 flex items-center gap-2 rounded-[11px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2 text-sm leading-relaxed text-negative"
          >
            <span class="min-w-0 flex-1">${error}</span>
            <button
              v-if=${!connected || (!loaded && !loading)}
              class="shrink-0 cursor-pointer rounded-lg border border-negative/25 bg-bg-light px-2.5 py-1.5 font-semibold text-negative disabled:cursor-default disabled:opacity-45"
              @click=${() => (connected ? this.#retryLoad() : reconnectTransport(true))}
            >
              ${connected ? i18n.get('global.retryLoad') : i18n.get('global.reconnect')}
            </button>
            <button
              v-else-if=${agentdeckStore.connectionError || pending}
              class="shrink-0 cursor-pointer rounded-lg border border-negative/25 bg-bg-light px-2.5 py-1.5 font-semibold text-negative"
              @click=${openSettings}
            >
              ${i18n.get('global.openSettings')}
            </button>
            <button
              v-else-if=${connected}
              class="shrink-0 cursor-pointer rounded-lg border border-negative/25 bg-bg-light px-2.5 py-1.5 font-semibold text-negative"
              @click=${() => clearSessionError(session.sessionId)}
            >
              ${i18n.get('global.close')}
            </button>
          </div>
          <div v-if=${agentdeckStore.permissionsBySession[session.sessionId]} class="px-2.5 pt-2">
            <deck-permission-request
              class="mx-auto max-w-[760px]"
              .request=${agentdeckStore.permissionsBySession[session.sessionId]}
              @resolve=${(event: CustomEvent<string | null>) => resolvePermission(session.sessionId, event.detail)}
            ></deck-permission-request>
          </div>
          <deck-composer
            ${this.#composerRef}
            .sessionKey=${this.sessionId}
            .mode=${getModeSelection(agentdeckStore.optionsBySession[session.sessionId])}
            ?mode-busy=${changingMode}
            @mode-change=${(event: CustomEvent<string>) => {
              void changeSessionMode(session, event.detail);
            }}
            .placeholder=${loading ? i18n.get('session.placeholderHistory') : !connected ? getConnectionLabel(agentdeckStore.connection) : loaded ? i18n.get('session.placeholderPrompt') : i18n.get('session.placeholderLoad')}
            .submit=${this.#send}
            ?disabled=${!loaded}
            ?ready=${connected && loaded}
            ?pending=${pending}
            @cancel=${() => cancelTurn(this.sessionId)}
            @preview=${this.#previewAttachment}
            @draft-change=${() => clearSessionError(this.sessionId)}
            @restore-change=${(event: CustomEvent<boolean>) => this.#state({ canRestoreInput: event.detail })}
          ></deck-composer>
        </footer>
      </tap-page>
      <deck-attachment-preview
        .attachment=${this.#state.previewAttachment}
        @close=${() => this.#state({ previewAttachment: null })}
      ></deck-attachment-preview>
    `;
  };
}
