import { Stack } from '@mantou/tap-ui/elements/stack';
import { icons } from '@mantou/tap-ui/lib/icons';

import { openSettings } from './settings';
import { agentApi, agentdeckStore, createDraftSession, refreshSessions } from './store';

const openSession = (sessionId: string) => {
  Stack.push({
    content: html`
      <agentdeck-session-page class="block h-full" .sessionId=${sessionId}></agentdeck-session-page>
    `,
    gesture: true,
  });
};

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

  tap-sheet::part(sheet) {
    max-width: 620px;
  }
`;

const stateLabel = {
  connecting: '正在连接 Relay',
  connected: 'Relay 已连接',
  reconnecting: '正在重新连接',
  disconnected: '尚未连接',
  preempted: '已被新会话取代',
} as const;

@customElement('agentdeck-session-list-page')
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class AgentDeckSessionListPageElement extends GemElement {
  #state = createState({
    sheetOpen: false,
    newSessionError: '',
  });

  #openNewSession = () => {
    if (agentdeckStore.connection !== 'connected') return;
    this.#state({ sheetOpen: true, newSessionError: '' });
  };

  #closeNewSession = () => this.#state({ sheetOpen: false, newSessionError: '' });

  #confirmNewSession = (cwd: string) => {
    const session = createDraftSession({ agent: agentdeckStore.settings.agent, cwd });
    this.#state({ sheetOpen: false, newSessionError: '' });
    openSession(session.sessionId);
  };

  @template()
  #render = () => {
    const { sheetOpen, newSessionError } = this.#state;
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
    const hasError = Boolean(sessionsError || connectionError);
    const hasGroups = Boolean(sessionGroups.length);
    const showSkeleton = !hasGroups && (sessionsLoading || !sessionsLoaded) && !hasError;

    return html`
      <tap-page class="bg-bg text-text">
        <header
          slot="header"
          class="menu-header flex items-center gap-4 bg-bg/90 px-5 pb-3.5 backdrop-blur-xl backdrop-saturate-125 min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[620px]"
        >
          <div class="flex min-w-0 items-center gap-3">
            <img class="size-11 shrink-0 rounded-[13px] shadow-card" src="/agentdeck-icon.png" alt="" />
            <div class="min-w-0">
              <h1 class="m-0 font-display text-xl font-[720] leading-none tracking-[-0.025em] text-highlight">
                AgentDeck
              </h1>
              <div class="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-describe">
                <span
                  class=${classMap({
                    'size-[7px] rounded-full bg-disabled': true,
                    'bg-positive ring-4 ring-positive/10': connection === 'connected',
                    'bg-negative ring-4 ring-negative/10': connection === 'preempted',
                    'animate-pulse bg-informative': connection === 'connecting' || connection === 'reconnecting',
                  })}
                ></span>
                <span>${stateLabel[connection]} · ${selectedAgent?.name || settings.agent}</span>
              </div>
            </div>
          </div>
        </header>

        <main
          class="menu-scroll no-scrollbar h-full overflow-auto px-4 pt-2 overscroll-y-contain min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[620px]"
        >
          <div
            v-if=${hasError}
            class="mb-4 rounded-[15px] border border-negative/30 bg-negative/[0.07] px-3.5 py-3 text-xs leading-relaxed text-negative"
          >
            ${sessionsError || connectionError}
          </div>

          <div v-if=${showSkeleton} class="flex flex-col gap-5" aria-label="正在加载会话">
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
                  @select=${(event: CustomEvent<string>) => openSession(event.detail)}
                ></deck-session-group>
              `,
            )}
          </div>

          <section
            v-if=${!showSkeleton && !hasGroups}
            class="mt-16 grid place-items-center px-8 py-10 text-center"
          >
            <div class="grid size-14 place-items-center rounded-[18px] border border-border bg-bg-light shadow-card">
              <tap-use class="size-6 text-describe" .element=${sessionsError ? icons.error : icons.menu}></tap-use>
            </div>
            <h2 class="mt-4 mb-1.5 font-display text-lg text-highlight">
              ${sessionsError ? '会话读取失败' : '这个 Agent 还没有会话'}
            </h2>
            <p class="m-0 max-w-[320px] text-sm leading-relaxed text-describe">
              ${
                sessionsError
                  ? '检查远端 Agent 是否在线，然后重新加载。'
                  : '会话由远端 ACP Agent 管理，出现后会按工作目录归到这里。'
              }
            </p>
            <button
              v-if=${sessionsError}
              class="mt-4 cursor-pointer rounded-xl border border-primary/20 bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary-strong active:scale-[0.98]"
              @click=${() => refreshSessions()}
            >
              重新加载
            </button>
          </section>
        </main>

        <footer slot="footer" class="menu-footer bg-bg/90 px-4 pt-2.5 backdrop-blur-xl backdrop-saturate-125 min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[620px]">
          <div class="flex items-center justify-between gap-3">
            <button
              class="flex h-12 min-w-0 px-4 cursor-pointer items-center justify-center gap-2 rounded-[15px] border-0 bg-primary text-sm font-bold text-white shadow-primary transition-transform active:scale-[0.985]"
              @click=${this.#openNewSession}
            >
              <tap-use class="size-[18px]" .element=${icons.add}></tap-use>
              新建会话
            </button>
            <button
              class="grid size-12 shrink-0 cursor-pointer place-items-center rounded-[15px] border border-border bg-bg-light text-highlight shadow-card transition-[transform,background-color] duration-150 active:scale-[0.94] active:bg-bg-hover"
              aria-label="打开设置"
              @click=${openSettings}
            >
              <tap-use class="size-[20px]" .element=${icons.tune}></tap-use>
            </button>
          </div>
        </footer>
      </tap-page>
      <tap-sheet ?open=${sheetOpen} gesture mask-closable @close=${this.#closeNewSession}>
        <h2 slot="header" class="m-0 font-display text-base font-[720] text-highlight">新建会话</h2>
        <deck-cwd-picker
          v-if=${sheetOpen}
          class="block"
          .complete=${(input: string) => agentApi.completeCwd(input)}
          .error=${newSessionError}
          @confirm=${(event: CustomEvent<string>) => this.#confirmNewSession(event.detail)}
        ></deck-cwd-picker>
      </tap-sheet>
    `;
  };
}
