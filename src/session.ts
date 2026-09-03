import { Stack } from '@mantou/tap-ui/elements/stack';
import { icons } from '@mantou/tap-ui/lib/icons';

import { markdownExtensions, markdownStyle, userMarkdownStyle } from './markdown';
import { displayPath } from './path';
import {
  agentdeckStore,
  type ChatMessage,
  cancelTurn,
  getOptionLabels,
  getSession,
  loadSession,
  resolvePermission,
  retrySessionLoad,
  sendPrompt,
} from './session-store';

const style = css`
  .session-header {
    min-height: calc(62px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
    padding-top: calc(10px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
  }

  .composer-shell {
    padding-bottom: calc(9px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }

  summary::-webkit-details-marker {
    display: none;
  }
`;

@customElement('agentdeck-session-page')
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class AgentDeckSessionPageElement extends GemElement {
  @property sessionId = '';

  #state = createState({ draft: '' });
  #messagesRef = createRef<HTMLElement>();
  #textareaRef = createRef<HTMLTextAreaElement>();
  #followMessages = true;
  #scrollFrame = 0;

  @effect((instance) => [instance.sessionId])
  #openSession = () => {
    this.#state({ draft: '' });
    this.#followMessages = true;
    void loadSession(this.sessionId);
    queueMicrotask(() => this.#scrollToLatest(true));
  };

  @effect((instance) => {
    const { sessionId } = instance;
    return [
      sessionId,
      agentdeckStore.messagesBySession[sessionId],
      agentdeckStore.pendingSessionIds.includes(sessionId),
      agentdeckStore.loadingSessionIds.includes(sessionId),
      agentdeckStore.permissionsBySession[sessionId],
    ];
  })
  #followLatest = () => {
    const pending = agentdeckStore.pendingSessionIds.includes(this.sessionId);
    this.#scrollToLatest(pending);
  };

  @unmounted()
  #cleanupFrame = () => cancelAnimationFrame(this.#scrollFrame);

  #onScroll = () => {
    const element = this.#messagesRef.value;
    if (!element) return;
    this.#followMessages = element.scrollHeight - element.clientHeight - element.scrollTop <= 44;
  };

  #scrollToLatest = (force = false) => {
    if (force) this.#followMessages = true;
    if (!this.#followMessages) return;
    cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = requestAnimationFrame(() => {
      const element = this.#messagesRef.value;
      if (element) element.scrollTop = element.scrollHeight;
    });
  };

  #setDraft = (value: string) => this.#state({ draft: value });

  #send = () => {
    if (!sendPrompt(this.sessionId, this.#state.draft)) return;
    this.#state({ draft: '' });
    if (this.#textareaRef.value) this.#textareaRef.value.value = '';
    this.#scrollToLatest(true);
  };

  #onKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.#send();
    }
  };

  #cancel = () => cancelTurn(this.sessionId);

  #retryLoad = () => {
    this.#followMessages = true;
    void retrySessionLoad(this.sessionId);
  };

  #renderMarkdown = (text: string, streaming = false, user = false) => html`
    <gem-bind-marked
      ?streaming=${streaming}
      .mdStyle=${user ? userMarkdownStyle : markdownStyle}
      .extensions=${markdownExtensions}
    >${text}</gem-bind-marked>
  `;

  #renderMessage = (message: ChatMessage) => {
    if ('type' in message && message.type === 'thought') {
      return html`
        <details class="mb-4 ml-9 border-s-2 border-primary/35 text-xs text-describe" ?open=${message.pending}>
          <summary class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1 font-semibold text-describe">
            <span
              class=${classMap({
                'size-1.5 shrink-0 rounded-full': true,
                'bg-informative ring-4 ring-informative/10': message.pending,
                'bg-disabled': !message.pending,
              })}
            ></span>
            ${message.pending ? '正在思考' : '思考过程'}
          </summary>
          <div class="mt-1 mb-0.5 min-w-0 px-3 pt-0.5 pb-2 leading-relaxed">
            ${this.#renderMarkdown(message.text, message.pending)}
          </div>
        </details>
      `;
    }
    if ('type' in message && message.type === 'tool') {
      return html`<deck-tool-call .data=${message.data}></deck-tool-call>`;
    }
    if ('role' in message && message.role === 'user') {
      return html`
        <div class="mb-[18px] flex justify-end">
          <div
            class="max-w-[min(86%,560px)] overflow-hidden rounded-[19px_19px_5px_19px] bg-primary px-3.5 py-[11px] text-sm leading-[1.55] text-white shadow-primary"
          >
            <div v-if=${message.attachments?.length} class="mb-2 flex flex-wrap justify-end gap-2">
              ${message.attachments?.map(
                (attachment) => html`
                  <img class="max-h-52 max-w-full rounded-xl" src=${attachment.previewUrl} alt=${attachment.name} />
                `,
              )}
            </div>
            ${this.#renderMarkdown(message.text, message.streaming, true)}
          </div>
        </div>
      `;
    }
    if ('role' in message) {
      return html`
        <article class="mb-5 grid grid-cols-[26px_minmax(0,1fr)] items-start gap-2.5">
          <div class="mt-0.5 grid size-[26px] place-items-center rounded-[9px] border border-border bg-bg-light" aria-hidden="true">
            <deck-icon></deck-icon>
          </div>
          <div class="min-w-0 px-px pt-px text-sm leading-[1.68] text-text">
            <div v-if=${message.attachments?.length} class="mb-2 flex flex-wrap gap-2">
              ${message.attachments?.map(
                (attachment) => html`
                  <img class="max-h-64 max-w-full rounded-xl border border-border" src=${attachment.previewUrl} alt=${attachment.name} />
                `,
              )}
            </div>
            ${this.#renderMarkdown(message.text, message.streaming)}
            <span
              v-if=${message.streaming}
              class="ml-1 inline-block h-[1em] w-[5px] animate-pulse rounded-sm bg-primary align-[-0.12em]"
              aria-label="正在生成"
            ></span>
          </div>
        </article>
      `;
    }
    return html``;
  };

  @template()
  #render = () => {
    const session = getSession(this.sessionId);
    if (!session) return html``;
    const messages = agentdeckStore.messagesBySession[session.sessionId] ?? [];
    const loading = agentdeckStore.loadingSessionIds.includes(session.sessionId);
    const loaded = agentdeckStore.loadedSessionIds.includes(session.sessionId);
    const pending = agentdeckStore.pendingSessionIds.includes(session.sessionId);
    const error = agentdeckStore.errorsBySession[session.sessionId];
    const connected = agentdeckStore.connection === 'connected';
    const canSend = Boolean(this.#state.draft.trim()) && connected && loaded && !pending;
    const optionLabels = getOptionLabels(session.sessionId);

    return html`
      <tap-page class="bg-bg text-text">
        <header
          slot="header"
          class="session-header relative grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-border/80 bg-bg-light/90 px-3 pb-2.5 backdrop-blur-xl backdrop-saturate-125"
        >
          <span aria-hidden="true" class="absolute inset-x-[21%] -bottom-[3px] h-[3px] rounded-b-md bg-primary/35"></span>
          <button
            class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight transition-[transform,background-color] duration-150 active:scale-[0.94] active:bg-primary-soft"
            aria-label="返回会话列表"
            @click=${() => Stack.close()}
          >
            <tap-use class="size-[20px]" .element=${icons.back}></tap-use>
          </button>
          <div class="min-w-0 text-center">
            <div class="truncate font-display text-[15px] leading-tight font-[720] text-highlight">
              ${session.title || '未命名会话'}
            </div>
            <div class="mt-1 flex min-w-0 items-center justify-center gap-1.5 text-[10px] font-medium text-describe">
              <span
                class=${classMap({
                  'size-1.5 shrink-0 rounded-full': true,
                  'bg-positive': connected && loaded,
                  'animate-pulse bg-informative': loading,
                  'bg-disabled': !connected || (!loaded && !loading),
                })}
              ></span>
              <span class="truncate font-mono">${displayPath(session.cwd)}</span>
            </div>
          </div>
          <div class="grid size-11 place-items-center" aria-hidden="true">
            <deck-icon></deck-icon>
          </div>
        </header>

        <main
          ${this.#messagesRef}
          class="no-scrollbar h-full overflow-x-hidden overflow-y-auto px-4 pt-[22px] pb-7 overscroll-y-contain sm:px-6"
          @scroll=${this.#onScroll}
        >
          <div class="mx-auto min-h-full w-full max-w-[720px]">
            <section v-if=${loading} class="grid min-h-full place-items-center content-center px-6 py-12 text-center">
              <div class="grid size-14 place-items-center rounded-[18px] border border-border bg-bg-light shadow-card">
                <tap-use class="size-6 text-primary" .element=${icons.loading}></tap-use>
              </div>
              <h2 class="mt-4 mb-1.5 font-display text-lg text-highlight">正在加载会话</h2>
              <p class="m-0 text-xs text-describe">连接远端 Agent，并回放历史事件…</p>
            </section>
            <div v-if=${!loading && !!messages.length} class="contents">
              <div class="mx-0.5 mt-0.5 mb-[22px] flex items-center gap-2.5 text-[10px] font-bold tracking-[0.06em] text-disabled uppercase">
                <span class="h-px flex-1 bg-border"></span>
                <span>历史与实时事件</span>
                <span class="h-px flex-1 bg-border"></span>
              </div>
              ${messages.map((message) => this.#renderMessage(message))}
              <deck-permission-request
                .request=${agentdeckStore.permissionsBySession[session.sessionId]}
                @resolve=${(event: CustomEvent<string | null>) => resolvePermission(session.sessionId, event.detail)}
              ></deck-permission-request>
            </div>
            <section
              v-if=${!loading && loaded && !messages.length}
              class="grid min-h-full place-items-center content-center px-5 py-8 text-center"
            >
              <div class="grid size-[54px] place-items-center rounded-[18px] border border-border bg-bg-light shadow-float">
                <deck-icon></deck-icon>
              </div>
              <h2 class="mt-[18px] mb-2 font-display text-xl tracking-[-0.02em] text-highlight">会话已就绪</h2>
              <p class="m-0 max-w-[280px] text-[13px] leading-relaxed text-describe">
                历史记录为空。发送消息后，回复、思考与工具进度会出现在同一条时间线上。
              </p>
            </section>
          </div>
        </main>

        <footer slot="footer">
          <div
            v-if=${error}
            class="mx-3 mb-2 flex items-center gap-2 rounded-[11px] border border-negative/30 bg-negative/[0.07] px-3 py-2 text-[11px] text-negative"
          >
            <span class="min-w-0 flex-1">${error}</span>
            <button
              v-if=${!loaded && !loading}
              class="shrink-0 cursor-pointer rounded-lg border border-negative/25 bg-bg-light px-2.5 py-1.5 font-semibold text-negative disabled:cursor-default disabled:opacity-45"
              ?disabled=${!connected}
              @click=${this.#retryLoad}
            >
              重试
            </button>
          </div>
          <div class="composer-shell bg-bg/90 px-2.5 pt-2 backdrop-blur-xl backdrop-saturate-125">
            <div class="mx-auto max-w-[760px] overflow-hidden rounded-[20px] border border-primary/15 bg-bg-light shadow-card">
              <textarea
                ${this.#textareaRef}
                class="block min-h-[50px] max-h-[120px] w-full resize-none border-0 bg-transparent px-3.5 pt-[13px] pb-1.5 text-sm leading-[1.45] text-highlight outline-0 [field-sizing:content] placeholder:text-disabled"
                rows="1"
                aria-label="发送消息"
                placeholder=${loading ? '正在回放历史…' : connected && loaded ? '交代一个任务…' : '等待 Relay 连接…'}
                .value=${this.#state.draft}
                @input=${(event: InputEvent) => this.#setDraft((event.target as HTMLTextAreaElement).value)}
                @keydown=${this.#onKeydown}
                ?disabled=${!loaded}
              ></textarea>
              <div class="flex min-h-[43px] items-center justify-between gap-2.5 pt-1 pr-1.5 pb-1.5 pl-3">
                <div class="flex min-w-0 items-center gap-2 text-[10px] font-semibold text-describe">
                  <deck-icon class="-mr-1 origin-left scale-[0.72]" aria-hidden="true"></deck-icon>
                  <span class="truncate">${session.agent} · ${optionLabels.join(' · ')}</span>
                </div>
                <button
                  v-if=${pending}
                  class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-[13px] border-0 bg-primary text-white transition-transform duration-150 active:scale-[0.92]"
                  aria-label="停止生成"
                  @click=${this.#cancel}
                >
                  <span class="size-2.5 rounded-[3px] bg-current"></span>
                </button>
                <button
                  v-else
                  class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-[13px] border-0 bg-primary text-white transition-[transform,background-color] duration-150 active:scale-[0.92] disabled:cursor-default disabled:bg-border disabled:text-disabled disabled:active:scale-100"
                  ?disabled=${!canSend}
                  aria-label="发送"
                  @click=${this.#send}
                >
                  <tap-use class="size-[17px]" .element=${icons.outward}></tap-use>
                </button>
              </div>
            </div>
          </div>
        </footer>
      </tap-page>
    `;
  };
}
