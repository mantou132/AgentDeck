import { Stack } from '@mantou/tap-ui/elements/stack';
import { icons } from '@mantou/tap-ui/lib/icons';

import { agentdeckStore, createSession } from './session-store';

const openSession = (sessionId: string) => {
  Stack.push({
    content: html`
      <agentdeck-session-page class="block h-full" .sessionId=${sessionId}></agentdeck-session-page>
    `,
    gesture: true,
  });
};

// Edge-to-edge insets are runtime values supplied by the native plugin, not
// visual theme tokens, so these two calculations intentionally remain CSS.
const style = css`
  .menu-header {
    padding-top: calc(14px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
  }

  .menu-scroll {
    padding-bottom: calc(28px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
`;

const stateLabel = {
  connecting: '正在连接',
  connected: 'Mock 已连接',
  reconnecting: '正在重连',
  disconnected: '未连接',
} as const;

const relativeTime = (date: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(date)) / 60_000));
  if (minutes < 2) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(date));
};

@customElement('agentdeck-menu-page')
@adoptedStyle(style)
@connectStore(agentdeckStore)
export class AgentDeckMenuPageElement extends GemElement {
  #newSession = () => openSession(createSession());

  @template()
  #render = () => {
    const { sessions, connection, transportLabel } = agentdeckStore;
    return html`
      <tap-page class="bg-bg text-text">
        <header
          slot="header"
          class="menu-header flex items-center justify-between gap-4 bg-bg/90 px-5 pb-3.5 backdrop-blur-xl backdrop-saturate-125 min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[560px]"
        >
          <div class="flex min-w-0 items-center gap-3">
            <img class="size-11 shrink-0 rounded-[13px] shadow-card" src="/agentdeck-icon.png" alt="" />
            <div class="min-w-0">
              <h1 class="m-0 font-display text-xl font-[720] leading-none tracking-[-0.025em] text-highlight">
                AgentDeck
              </h1>
              <div class="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-describe">
                <span
                  class=${classMap({
                    'size-[7px] rounded-full bg-disabled': true,
                    'bg-positive ring-4 ring-positive/10': connection === 'connected',
                  })}
                ></span>
                <span>${stateLabel[connection]}</span>
              </div>
            </div>
          </div>
          <button
            class="grid size-[42px] shrink-0 cursor-pointer place-items-center rounded-[14px] border-0 bg-primary text-white shadow-primary transition-[transform,background-color] duration-150 active:scale-[0.94] active:bg-primary-strong"
            aria-label="新建会话"
            @click=${this.#newSession}
          >
            <tap-use class="size-[21px]" .element=${icons.add}></tap-use>
          </button>
        </header>

        <main
          class="menu-scroll no-scrollbar h-full overflow-auto px-4 pt-2 overscroll-y-contain min-[680px]:mx-auto min-[680px]:w-full min-[680px]:max-w-[560px]"
        >
          <button
            class="mt-1 mb-[26px] flex min-h-[58px] w-full cursor-pointer items-center gap-3 rounded-[18px] border border-primary/20 bg-primary-soft px-3.5 py-2.5 text-left text-primary-strong transition-transform duration-150 active:scale-[0.985]"
            @click=${this.#newSession}
          >
            <span class="grid size-[34px] shrink-0 place-items-center rounded-[11px] bg-primary text-white">
              <tap-use class="size-[18px]" .element=${icons.add}></tap-use>
            </span>
            <span>
              <strong class="block text-[15px] leading-tight font-semibold text-highlight">开始新会话</strong>
              <small class="mt-1 block text-xs text-describe">选择 Agent，然后交代任务</small>
            </span>
          </button>

          <h2 class="mx-2 mt-0 mb-2.5 text-[11px] font-[720] tracking-[0.08em] text-describe uppercase">
            最近会话
          </h2>
          <div class="flex flex-col gap-2">
            ${sessions.map(
              (session) => html`
                <button
                  class="grid min-h-[76px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 overflow-hidden rounded-[17px] border border-border bg-bg-light py-3 pr-[13px] pl-[15px] text-left text-text shadow-card transition-[transform,background-color] duration-150 active:scale-[0.985] active:bg-bg-hover"
                  @click=${() => openSession(session.id)}
                >
                  <span class="min-w-0">
                    <span class="block truncate text-[15px] leading-snug font-semibold text-highlight">
                      ${session.title}
                    </span>
                    <span class="mt-2 flex min-w-0 items-center gap-2 text-[11px] text-describe">
                      <span class="shrink-0 rounded-[7px] bg-primary-soft px-2 py-0.5 font-bold text-primary-strong">
                        ${session.agent}
                      </span>
                      <span class="min-w-0 truncate font-mono">${session.cwd}</span>
                    </span>
                  </span>
                  <span class="flex flex-col items-end gap-2.5 text-[10px] text-disabled">
                    <span>${relativeTime(session.updatedAt)}</span>
                    <tap-use class="size-[15px]" .element=${icons.right}></tap-use>
                  </span>
                </button>
              `,
            )}
          </div>

          <section
            class="mt-7 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[17px] border border-border bg-bg-light/70 p-3.5"
            aria-label="连接信息"
          >
            <span class="grid size-9 place-items-center rounded-xl bg-bg-light text-positive shadow-card">
              <tap-use class="size-[18px]" .element=${icons.success}></tap-use>
            </span>
            <span class="min-w-0">
              <span class="flex items-baseline justify-between gap-3 text-[13px] font-semibold text-highlight">
                <span>ACP transport</span>
                <span class="font-mono text-[9px] font-semibold tracking-[0.08em] text-describe uppercase">
                  ${transportLabel}
                </span>
              </span>
              <span class="mt-1 block min-w-0 truncate font-mono text-[10px] text-describe">
                ws://127.0.0.1:4789/acp
              </span>
            </span>
          </section>
        </main>
      </tap-page>
    `;
  };
}
