import { history } from '@mantou/gem/lib/history';
import type { EndEventDetail } from '@mantou/tap-ui/elements/gesture';
import { Sheet } from '@mantou/tap-ui/elements/sheet';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { reconnectTransport } from '../agent/transport';
import { draftKey, removeDraft, restoreDraft } from '../composer/drafts';
import type { ComposerInput, DeckComposerElement } from '../elements/composer';
import { openSessionConfig } from '../elements/session-config';
import { getConnectionLabel, i18n } from '../i18n';
import { followBottom } from '../lib/follow-bottom';
import { hapticImpact } from '../lib/haptics';
import { displayPath } from '../lib/path';
import { openChanges, openSettings, replaceSession } from '../navigation';
import { getConfigLabel, getConfigSelects } from '../session/config-options';
import type { Attachment, DeckSession } from '../session/types';
import {
  cancelTurn,
  closeSession,
  createPendingSession,
  ensureSessionLoaded,
  getSession,
  promotePendingSession,
  resetPendingSession,
  resolvePermission,
  retrySessionLoad,
  sendPrompt,
} from '../state/sessions';
import { agentdeckStore, clearSessionError, setSessionError, setSessionFlag } from '../state/store';
import { icons } from '../styles/icons';

const style = css`
  .session-header {
    padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
  }
`;

@customElement('agentdeck-session-page')
@adoptedStyle(style)
@connectStore(agentdeckStore)
@connectStore(history.store)
export class AgentDeckSessionPageElement extends GemElement {
  @property sessionId = '';

  #state = createState({ followMessages: true, deferTimeline: false, entered: false, voiceChat: false });
  #messagesRef = createRef<HTMLElement>();
  #messagesContentRef = createRef<HTMLElement>();
  #composerRef = createRef<DeckComposerElement>();
  #following?: ReturnType<typeof followBottom>;

  #onEnd = (evt: CustomEvent<EndEventDetail>) => {
    if (evt.detail.pressed) {
      closeSession(this.sessionId);
      Stack.pop();
    }
  };

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

  #onAsk = (evt: CustomEvent<string>) => {
    this.#composerRef.value?.quoteText(evt.detail);
  };

  @effect((instance) => [instance.sessionId])
  #openSession = () => {
    ensureSessionLoaded(this.sessionId);
    // Remote load may return midway through the enter animation; delay timeline rendering until animation finishes. Existing in-memory sessions render immediately
    this.#state({ deferTimeline: agentdeckStore.loadingSessionIds.includes(this.sessionId) });
  };

  get #loading() {
    const { deferTimeline, entered } = this.#state;
    return agentdeckStore.loadingSessionIds.includes(this.sessionId) || (deferTimeline && !entered);
  }

  // After history replay finishes, messages render all at once; jump directly to the bottom without smooth catching-up
  @effect((i) => [i.#loading])
  #jumpAfterHistory = () => {
    if (!this.#loading) this.#following?.resume();
  };

  @effect((i) => [i.sessionId, i.#messagesRef.value, i.#messagesContentRef.value])
  #followMessages = () => {
    this.#following = followBottom(this.#messagesRef.value, this.#messagesContentRef.value, {
      onFollowingChange: (followMessages) => this.#state({ followMessages }),
    });
    return this.#following?.disconnect;
  };

  @effect(() => [])
  #cleanupPendingSession = () => () => {
    if (this.sessionId === 'pending-session') {
      resetPendingSession();
    }
  };

  #restoreFailedInput = async (session: DeckSession, input: ComposerInput) => {
    const key = draftKey(session);
    try {
      // Preserve new content typed by the user for the next turn.
      const restored = await restoreDraft(key, input);
      this.#composerRef.value?.restoreIfEmpty(key, restored);
    } catch {
      this.#composerRef.value?.restoreIfEmpty(key, input);
      setSessionError(session.sessionId, i18n.get('composer.draftSaveFailed'));
    }
  };

  #send = async (input: ComposerInput) => {
    const session = getSession(this.sessionId);
    if (!session) {
      this.#composerRef.value?.restore(input);
      return false;
    }

    const { text, attachments, voiceChat } = input;
    const originalDraftKey = draftKey(session);
    let targetSession = session;
    let accepted = false;
    let failed = false;
    let submissionComplete = false;

    const onFailed = () => {
      failed = true;
      // Record failure during submission first, then restore after session switching and old draft cleanup complete.
      if (submissionComplete) this.#restoreFailedInput(targetSession, input);
    };

    try {
      if (session.pendingCreation) {
        const liveSession = await promotePendingSession(session, text, attachments, onFailed, voiceChat);
        if (liveSession) {
          targetSession = liveSession;
          // Switch to the live session before dropping the pending one, so the page never renders without a session.
          this.sessionId = liveSession.sessionId;
          resetPendingSession();
          accepted = true;
        }
      } else {
        accepted = sendPrompt(session.sessionId, text, attachments, onFailed, voiceChat);
      }

      // Once submission is accepted and in-flight persistence takes over input, the original draft can be deleted.
      if (accepted) await removeDraft(originalDraftKey);
    } catch {
      failed = true;
    } finally {
      submissionComplete = true;
    }

    if (failed || !accepted) await this.#restoreFailedInput(targetSession, input);
    return accepted;
  };

  #previewAttachment = (event: CustomEvent<Attachment>) => {
    Sheet.open({
      maskClosable: true,
      body: html`<deck-attachment-preview .attachment=${event.detail}></deck-attachment-preview>`,
    });
  };

  #retryLoad = () => {
    retrySessionLoad(this.sessionId);
  };

  #renderHeader = (title: string, cwd?: string) => {
    const connected = agentdeckStore.connection === 'connected';
    return html`
      <header
        slot="header"
        class="session-header grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-border-strong px-3 pb-1.5"
      >
        <tap-gesture
          role="button"
          class="grid size-11 cursor-pointer select-none touch-manipulation place-items-center rounded-[14px] border-0 bg-transparent text-highlight transition-[transform,background-color] duration-150 active:scale-[0.94] active:bg-primary-soft"
          aria-label=${i18n.get('session.backAria')}
          title=${i18n.get('session.backTitle')}
          @press=${() => hapticImpact('medium')}
          @click=${() => Stack.pop()}
          @end=${this.#onEnd}
          @contextmenu=${(e: Event) => e.preventDefault()}
        >
          <tap-use class="size-[20px]" .element=${icons.back}></tap-use>
        </tap-gesture>
        <div class="flex min-w-0 flex-col items-center text-center">
          <div class="max-w-full truncate font-display text-base font-semibold text-highlight">${title}</div>
          <button
            v-if=${cwd}
            type="button"
            class="group mt-0.5 flex max-w-full cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent px-2 text-xs text-describe transition-[background-color,transform] duration-150 active:scale-[0.97]"
            title=${i18n.get('changes.viewChanges')}
            @click=${() => {
              if (!cwd) return;
              openChanges(cwd);
            }}
          >
            <span class="truncate font-mono">${displayPath(cwd || '')}</span>
          </button>
        </div>
        <button
          class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight transition-[transform,background-color] duration-150 active:scale-[0.94] active:bg-primary-soft disabled:cursor-default disabled:opacity-45"
          aria-label=${i18n.get('session.newSessionHereAria')}
          ?disabled=${!connected || !cwd}
          @click=${() => {
            if (!cwd) return;
            const pendingSession = createPendingSession({ agent: agentdeckStore.settings.agent, cwd });
            replaceSession(pendingSession.sessionId);
          }}
        >
          <tap-use class="size-[20px]" .element=${icons.add}></tap-use>
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
    const loading = this.#loading;
    const loaded = agentdeckStore.loadedSessionIds.includes(session.sessionId);
    const pending = agentdeckStore.pendingSessionIds.includes(session.sessionId);
    const error =
      agentdeckStore.errorsBySession[session.sessionId] ||
      agentdeckStore.connectionError ||
      (!loaded && !loading ? i18n.get('session.notLoaded') : '');
    const connected = agentdeckStore.connection === 'connected';
    return html`
      <tap-page class="bg-bg text-text" .trackVisibility=${false} @full-show=${() => this.#state({ entered: true })}>
        ${this.#renderHeader(session.title || (session.pendingCreation ? i18n.get('session.newTitle') : i18n.get('session.untitled')), session.cwd)}

        <div class="relative h-full">
          <main
            ${this.#messagesRef}
            class="no-scrollbar h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
            tabindex="0"
            aria-label=${i18n.get('session.messagesAria')}
          >
            <div
              ${this.#messagesContentRef}
              class="mx-auto flex min-h-full w-full max-w-[720px] flex-col px-4 pt-4 pb-5 sm:px-6"
            >
              <section v-if=${loading} class="grid flex-1 place-items-center content-center px-6 py-12 text-center">
                <div class="grid size-14 place-items-center rounded-[18px] border border-border bg-bg-light shadow-card">
                  <tap-use class="size-6 text-primary" .element=${icons.loading}></tap-use>
                </div>
                <h2 class="mt-4 mb-1.5 font-display text-lg font-semibold text-highlight">${i18n.get('session.loadingTitle')}</h2>
                <p class="m-0 text-sm text-describe">${i18n.get('session.loadingDesc')}</p>
              </section>
              <deck-session-timeline
                v-if=${!loading && !!messages.length}
                .sessionKey=${this.sessionId}
                .cwd=${session.cwd}
                .messages=${messages}
                ?pending=${pending}
                @preview=${this.#previewAttachment}
                @ask=${this.#onAsk}
              ></deck-session-timeline>
              <section
                v-if=${!loading && loaded && !messages.length}
                class="grid flex-1 place-items-center content-center px-5 py-8 text-center"
              >
                <div class="grid size-[54px] place-items-center rounded-[18px] border border-border bg-bg-light shadow-float">
                  <deck-icon></deck-icon>
                </div>
                <h2 class="mt-[18px] mb-2 font-display text-lg font-semibold tracking-[-0.02em] text-highlight">
                  ${session.pendingCreation ? i18n.get('session.newSession') : i18n.get('session.ready')}
                </h2>
                <p class="m-0 max-w-[280px] text-sm leading-relaxed text-describe">
                  ${session.pendingCreation ? i18n.get('session.newSessionHint') : i18n.get('session.emptyHistoryHint')}
                </p>
              </section>
            </div>
          </main>
          <button
            v-if=${!this.#state.followMessages}
            type="button"
            class="absolute bottom-3 left-1/2 flex min-h-10 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-primary/20 bg-bg-light px-3.5 text-sm font-semibold whitespace-nowrap text-primary-strong shadow-float active:bg-primary-soft"
            @click=${() => this.#following?.resume()}
          >
            <tap-use class="size-4" .element=${icons.arrowDown}></tap-use>
            ${i18n.get('session.scrollToLatest')}
          </button>
        </div>

        <footer slot="footer">
          <div
            v-if=${error}
            class="mx-3 mb-2 flex items-center gap-2 rounded-[11px] border border-negative/30 bg-negative/[0.07] px-3.5 py-2 text-sm leading-relaxed text-negative"
          >
            <span class="select-text min-w-0 flex-1">${error}</span>
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
            .draftKey=${draftKey(session)}
            config-label=${getConfigLabel(getConfigSelects(agentdeckStore.optionsBySession[session.sessionId]))}
            @config-open=${() => openSessionConfig(session.sessionId)}
            .placeholder=${loading ? i18n.get('session.placeholderHistory') : !connected ? getConnectionLabel(agentdeckStore.connection) : loaded ? i18n.get('session.placeholderPrompt') : i18n.get('session.placeholderLoad')}
            .suggestion=${connected && loaded ? (agentdeckStore.suggestionsBySession[session.sessionId] ?? '') : ''}
            .submit=${this.#send}
            ?disabled=${!loaded}
            ?ready=${connected && loaded}
            ?pending=${pending}
            @cancel=${() => cancelTurn(this.sessionId)}
            @preview=${this.#previewAttachment}
            @draft-change=${() => clearSessionError(this.sessionId)}
            @voice-chat=${() => this.#state({ voiceChat: true })}
          ></deck-composer>
        </footer>
      </tap-page>
      <deck-sheet
        ?open=${this.#state.voiceChat}
        .snap=${[0.7]}
        .heading=${i18n.get('voiceChat.heading')}
        @close=${() => this.#state({ voiceChat: false })}
        .content=${html`
          <deck-voice-chat
            .sessionId=${this.sessionId}
            .submit=${this.#send}
            ?ready=${connected && loaded}
            ?active=${this.#state.voiceChat}
          ></deck-voice-chat>
        `}
      ></deck-sheet>
    `;
  };
}
