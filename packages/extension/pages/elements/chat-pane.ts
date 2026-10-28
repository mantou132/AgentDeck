import type { Emitter } from '@mantou/gem/lib/decorators';
import type { PermissionRequest, SessionConfigOption } from 'agentdeck/agent/api';
import { followBottom } from 'agentdeck/lib/follow-bottom';
import { t } from '../../shared/i18n';
import type { PanelMessage, PromptPayload, QueueItem } from '../agent-panel/types';
import type { AgentComposerElement, ConfigChange } from './composer';

@customElement('agent-chat-pane')
export class AgentChatPaneElement extends GemElement {
  @boolattribute compact: boolean;
  @boolattribute loadingSession: boolean;
  @boolattribute turnPending: boolean;
  @property sessionKey: string | null = null;
  @property title = '';
  @property cwd = '';
  @property messages: PanelMessage[] = [];
  @property permissionRequest?: PermissionRequest;
  @property bannerError = '';
  @property configOptions: SessionConfigOption[] = [];
  /** Prompts staged while a turn is in flight. */
  @property queue: QueueItem[] = [];

  @emitter send: Emitter<PromptPayload>;
  @emitter cancel: Emitter;
  @emitter configchange: Emitter<ConfigChange>;
  /** Detail: permission optionId (`null` declines). */
  @emitter decision: Emitter<string | null>;
  @emitter attacherror: Emitter<string>;
  /** Detail: queued item id. */
  @emitter queuesend: Emitter<string>;
  @emitter queueupdate: Emitter<QueueItem>;
  /** Detail: queued item id. */
  @emitter queueremove: Emitter<string>;

  #messagesRef = createRef<HTMLElement>();
  #messagesContentRef = createRef<HTMLElement>();
  #composerRef = createRef<AgentComposerElement>();
  #following?: ReturnType<typeof followBottom>;

  /** The prompt gets focus once a session view becomes chattable. */
  @effect((i) => [i.sessionKey, i.loadingSession])
  #onSessionViewChange = () => {
    if (!this.sessionKey || this.loadingSession) return;
    this.#composerRef.value?.focus();
  };

  /** Each session view starts pinned to the bottom and stays there unless the user scrolls up. */
  @effect((i) => [i.sessionKey, i.#messagesRef.value, i.#messagesContentRef.value])
  #followMessages = () => {
    this.#following = followBottom(this.#messagesRef.value, this.#messagesContentRef.value);
    return this.#following?.disconnect;
  };

  /** Re-enable following, e.g. when the user sends a message. */
  scrollToLatest = () => this.#following?.resume();

  @template()
  #content = () => {
    const {
      compact,
      sessionKey,
      title,
      cwd,
      messages,
      loadingSession,
      permissionRequest,
      bannerError,
      configOptions,
      turnPending,
      queue,
    } = this;
    const canChat = Boolean(sessionKey);

    return html`
      <section class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        <header v-if=${!compact && !loadingSession && canChat} class="border-b border-border px-4 py-2.5 bg-bg">
          <span class="block truncate text-sm font-medium text-highlight" title=${sessionKey || ''}>${title}</span>
          <span
            v-if=${!!cwd}
            class="mt-0.5 block truncate font-mono text-xs text-describe"
            title=${cwd}
          >
            ${cwd}
          </span>
        </header>
        <div v-if=${loadingSession} class="grid min-h-0 flex-1 place-items-center text-describe">
          <span class="flex items-center gap-2">
            <dy-loading></dy-loading>
            <span>${t('devtoolsPanelLoading')}</span>
          </span>
        </div>
        <div
          v-if=${!loadingSession && !canChat}
          class="grid min-h-0 flex-1 place-items-center px-8 text-center text-describe"
        >
          <dy-empty text=${t('devtoolsPanelEmpty')}></dy-empty>
        </div>
        <div
          v-if=${!loadingSession && canChat}
          ${this.#messagesRef}
          class="min-h-0 flex-1 overflow-auto px-4 py-2"
        >
          <div ${this.#messagesContentRef} class="flex flex-col">
            ${messages.map(
              (msg) => html`
                  <agent-message-bubble
                    .message=${msg}
                    .streamKey=${sessionKey}
                    ?streaming=${turnPending && (msg.type === 'thought' ? msg.pending : msg.type === undefined && msg.role === 'agent')}
                  ></agent-message-bubble>
              `,
            )}
            <agent-permission-request
              v-if=${!!permissionRequest}
              class="mb-1 mt-2 block"
              .request=${permissionRequest}
              @decision=${(e: CustomEvent<string | null>) => this.decision(e.detail)}
            ></agent-permission-request>
          </div>
        </div>
        <div v-if=${!!bannerError} class="border-t border-negative/30 bg-negative/5 px-4 py-2 text-xs text-negative">
          ${bannerError}
        </div>
        <footer v-if=${!loadingSession && canChat} class="bg-bg px-4 pb-4 pt-2">
          <agent-composer
            ${this.#composerRef}
            class="block"
            ?turn-pending=${turnPending}
            .configOptions=${configOptions}
            .sessionKey=${sessionKey}
            .queue=${queue}
            @send=${(e: CustomEvent<PromptPayload>) => this.send(e.detail)}
            @cancel=${() => this.cancel()}
            @configchange=${(e: CustomEvent<ConfigChange>) => this.configchange(e.detail)}
            @attacherror=${(e: CustomEvent<string>) => this.attacherror(e.detail)}
            @queuesend=${(e: CustomEvent<string>) => this.queuesend(e.detail)}
            @queueupdate=${(e: CustomEvent<QueueItem>) => this.queueupdate(e.detail)}
            @queueremove=${(e: CustomEvent<string>) => this.queueremove(e.detail)}
          ></agent-composer>
        </footer>
      </section>
    `;
  };
}
