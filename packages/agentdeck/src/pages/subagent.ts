import { Stack } from '@mantou/tap-ui/elements/stack';
import type { Attachment } from '../attachment/types';
import { getSubagentStatus, getSubagentTitle, isSubagentActive } from '../elements/subagent-card';
import { i18n } from '../i18n';
import { followBottom } from '../lib/follow-bottom';
import { openAttachment } from '../navigation';
import { cancelSubagent, getSession } from '../state/sessions';
import { getMessages, getRuntime, messagesStore, sessionsStore } from '../state/store';
import { resolvePermission } from '../state/user-input';
import { icons } from '../styles/icons';
import { style } from './session';

/**
 * Subagent `subagentId` of session `sessionId` (ACP Subagent Sessions RFD) is watched, never prompted, loaded or
 * resumed: its updates arrive with its root session's. Its permission requests and questions are kept on the root
 * session and can be answered here too; it can be stopped when its agent allows it.
 */
@customElement('agentdeck-subagent-page')
@adoptedStyle(style)
@connectStore(sessionsStore)
@connectStore(messagesStore)
export class AgentDeckSubagentPageElement extends GemElement {
  @property sessionId = '';
  @property subagentId = '';

  #messagesRef = createRef<HTMLElement>();
  #messagesContentRef = createRef<HTMLElement>();

  @effect((i) => [i.subagentId, i.#messagesRef.value, i.#messagesContentRef.value])
  #followMessages = () => followBottom(this.#messagesRef.value, this.#messagesContentRef.value)?.disconnect;

  #previewAttachment = ({ detail: attachment }: CustomEvent<Attachment>) =>
    openAttachment(attachment, getSession(this.sessionId)?.cwd ?? '');

  @template()
  #render = () => {
    const { subagents, permission, elicitations = [] } = getRuntime(this.sessionId);
    const subagent = subagents?.[this.subagentId];
    const messages = getMessages(this.subagentId);
    const cwd = getSession(this.sessionId)?.cwd ?? '';
    const active = isSubagentActive(subagent);
    const ownPermission = permission?.childSessionId === this.subagentId ? permission : undefined;
    return html`
      <tap-page class="bg-bg text-text">
        <header
          slot="header"
          class="session-header grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-border-strong px-3 pb-1.5"
        >
          <button
            type="button"
            class="grid size-11 cursor-pointer place-items-center rounded-[14px] border-0 bg-transparent text-highlight active:scale-[0.94] active:bg-primary-soft"
            aria-label=${i18n.get('session.backAria')}
            @click=${() => Stack.pop()}
          >
            <tap-use class="size-[20px]" .element=${icons.back}></tap-use>
          </button>
          <div class="flex min-w-0 flex-col items-center text-center">
            <div class="max-w-full truncate font-display text-base font-semibold text-highlight">
              ${getSubagentTitle(subagent)}
            </div>
            <div class="mt-0.5 max-w-full truncate text-xs text-describe">${getSubagentStatus(subagent)}</div>
          </div>
          <span></span>
        </header>
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
            <p v-if=${!messages.length} class="m-auto text-sm text-describe">${i18n.get('subagent.empty')}</p>
            <deck-session-timeline
              v-else
              .sessionKey=${this.subagentId}
              .rootSessionKey=${this.sessionId}
              .cwd=${cwd}
              .messages=${messages}
              .elicitations=${elicitations.filter((item) => item.request.childSessionId === this.subagentId)}
              ?pending=${active}
              @preview=${this.#previewAttachment}
            ></deck-session-timeline>
          </div>
        </main>
        <footer slot="footer" class="px-2.5 pb-[max(10px,env(safe-area-inset-bottom,0px))]">
          <deck-permission-request
            v-if=${!!ownPermission}
            class="mx-auto mt-2 max-w-[760px]"
            .request=${ownPermission}
            @resolve=${(event: CustomEvent<string | null>) => resolvePermission(this.sessionId, event.detail)}
          ></deck-permission-request>
          <button
            v-if=${active && !!subagent?.cancellable}
            type="button"
            class="mx-auto mt-2 flex min-h-11 w-full max-w-[760px] cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-bg-light text-sm font-semibold text-negative active:scale-[0.98]"
            @click=${() => cancelSubagent(this.sessionId, this.subagentId)}
          >
            <tap-use class="size-4" .element=${icons.stop}></tap-use>
            ${i18n.get('subagent.stop')}
          </button>
        </footer>
      </tap-page>
    `;
  };
}
