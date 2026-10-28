import { isPairingId } from 'agentdeck/agent/encryption';
import { agentApi, closeTransport } from 'agentdeck/agent/transport';
import { displayPath } from 'agentdeck/lib/path';
import { type SessionRecord, updateAgentPanelState } from '../shared/agent-session-store';
import { AGENTS } from '../shared/agents';
import { setPageI18n, t } from '../shared/i18n';
import {
  mountAgentApi,
  mountBootstrap,
  mountCompactMode,
  mountStoredState,
  startExtensionTransport,
} from './agent-panel/effects';
import { createSessionController, type SessionController } from './agent-panel/session-controller';
import { createSessionRuntime } from './agent-panel/session-runtime';
import { createTurnController } from './agent-panel/turn-controller';
import type { PanelState, PromptPayload, QueueItem } from './agent-panel/types';
import type { AgentChatPaneElement } from './elements/chat-pane';
import type { ConfigChange, SelectOption } from './elements/composer';
import type { NewSessionChoice } from './elements/new-session-picker';

setPageI18n();

const style = css`
  :scope {
    display: block;
    height: 100vh;
    font-size: 14px;
  }
`;

@customElement('agent-panel-page')
@adoptedStyle(style)
class AgentPanelPageElement extends GemElement {
  @boolattribute showEvents: boolean;

  #s = createState<PanelState>({
    compact: false,
    sessions: [],
    draftSession: null,
    defaults: { agent: '', configOptionsByAgent: {} },
    sessionKey: null,
    messages: [],
    configOptions: [],
    queue: [],
    pendingIds: [],
    booting: true,
    loadingIds: [],
    deleting: null,
    error: '',
    sessionErrors: {},
    cwd: '',
    home: '',
    newSessionOpen: false,
    settingsOpen: false,
    relayId: '',
    permissions: {},
  });

  #chatPaneRef = createRef<AgentChatPaneElement>();
  #runtime = createSessionRuntime(this.#s);
  #turns = createTurnController({
    state: this.#s,
    runtime: this.#runtime,
    api: agentApi,
    scrollToLatest: () => this.#chatPaneRef.value?.scrollToLatest(),
    startDraftTurn: (...args) => this.#sessions.startDraftTurn(...args),
  });
  #sessions: SessionController = createSessionController({
    state: this.#s,
    runtime: this.#runtime,
    turns: this.#turns,
    api: agentApi,
  });

  @effect(() => [])
  #bootstrap = () => mountBootstrap(this.#s);

  @effect(() => [])
  #observeStoredState = () => mountStoredState(this.#s);

  @effect(() => [])
  #observeCompactMode = () => mountCompactMode(this.#s);

  @effect(() => [])
  #bindAgentApi = () => mountAgentApi({ sessions: this.#sessions, turns: this.#turns, state: this.#s });

  #connectRelay = async ({ detail }: CustomEvent<string>) => {
    const id = detail.trim();
    if (id && isPairingId(id)) {
      await startExtensionTransport(id);
    } else {
      closeTransport();
    }
    await updateAgentPanelState((prev) => ({ ...prev, relayId: id }));
    this.#s({ settingsOpen: false, relayId: id, error: '' });
  };

  /** Selectable session config options (mode/model/effort/…) for the composer. */
  get #configSelects() {
    return this.#s.configOptions.filter(
      (option): option is SelectOption => option.type === 'select' && option.options.length > 0,
    );
  }

  get #currentTitle() {
    return this.#runtime.record(this.#s.sessionKey)?.title || t('devtoolsPanelNewSession');
  }

  get #recentCwd() {
    const timestamp = (session: SessionRecord) => Date.parse(session.updatedAt || '') || 0;
    const recent = this.#runtime
      .list()
      .filter((session) => session.cwd)
      .reduce<SessionRecord | null>(
        (recent, session) => (!recent || timestamp(session) > timestamp(recent) ? session : recent),
        null,
      );
    return recent?.cwd || this.#s.cwd;
  }

  @template()
  #content = () => {
    const {
      compact,
      sessionKey,
      cwd,
      defaults,
      messages,
      booting,
      loadingIds,
      deleting,
      error,
      sessionErrors,
      pendingIds,
      permissions,
      newSessionOpen,
      settingsOpen,
      relayId,
      home,
      queue,
    } = this.#s;

    if (booting) {
      return html`
        <div class="grid h-full place-items-center bg-bg text-describe">
          <dy-loading></dy-loading>
        </div>
      `;
    }

    const visibleMessages = this.showEvents ? messages : messages.filter((message) => message.type !== 'event');
    const loadingSession = !!sessionKey && loadingIds.includes(sessionKey) && !this.#runtime.record(sessionKey)?.draft;
    const bannerError = error || (sessionKey && sessionErrors[sessionKey]) || '';
    const initialAgent = AGENTS.some((agent) => agent.id === defaults.agent) ? defaults.agent : AGENTS[0].id;

    return html`
      <div class=${compact ? 'flex h-full flex-col' : 'flex h-full'}>
        <agent-session-list
          class="contents"
          ?compact=${compact}
          .sessions=${this.#runtime.list()}
          .sessionKey=${sessionKey}
          .home=${home}
          .loadingIds=${loadingIds}
          .deleting=${deleting}
          @select=${(e: CustomEvent<string>) => this.#sessions.openSession(e.detail)}
          @create=${this.#sessions.openNewSession}
          @remove=${(e: CustomEvent<string>) => this.#sessions.deleteSession(e.detail)}
        ></agent-session-list>
        <agent-chat-pane
          ${this.#chatPaneRef}
          class="contents"
          ?compact=${compact}
          ?loading-session=${loadingSession}
          .sessionKey=${sessionKey}
          .title=${this.#currentTitle}
          .cwd=${displayPath(cwd, home)}
          .messages=${visibleMessages}
          .permissionRequest=${sessionKey ? permissions[sessionKey] : null}
          .bannerError=${bannerError}
          .configOptions=${this.#configSelects}
          ?turn-pending=${!!sessionKey && pendingIds.includes(sessionKey)}
          .queue=${queue}
          @send=${(e: CustomEvent<PromptPayload>) => this.#turns.send(e.detail)}
          @cancel=${this.#turns.cancel}
          @configchange=${(e: CustomEvent<ConfigChange>) => this.#sessions.changeConfig(e.detail.configId, e.detail.value)}
          @decision=${(e: CustomEvent<string | null>) => this.#turns.decidePermission(sessionKey, e.detail)}
          @attacherror=${(e: CustomEvent<string>) => this.#runtime.setError(sessionKey, e.detail)}
          @queuesend=${(e: CustomEvent<string>) => sessionKey && this.#turns.flushQueued(sessionKey, e.detail)}
          @queueupdate=${(e: CustomEvent<QueueItem>) => sessionKey && this.#turns.updateQueued(sessionKey, e.detail)}
          @queueremove=${(e: CustomEvent<string>) => sessionKey && this.#turns.removeQueued(sessionKey, e.detail)}
        ></agent-chat-pane>
        <agent-modal
          v-if=${newSessionOpen}
          .open=${true}
          .customize=${true}
          .maskClosable=${true}
          @close=${() => this.#s({ newSessionOpen: false })}
        >
          <agent-new-session-picker
            class="block w-[calc(100vw-2rem)] max-w-2xl"
            .complete=${(value: string) => agentApi.completeCwd(value)}
            .initialValue=${displayPath(this.#recentCwd, home)}
            .home=${home}
            .agents=${AGENTS}
            .initialAgent=${initialAgent}
            @confirm=${(e: CustomEvent<NewSessionChoice>) => this.#sessions.confirmNewSession(e.detail)}
          ></agent-new-session-picker>
        </agent-modal>
        <agent-modal
          v-if=${settingsOpen}
          .open=${true}
          .customize=${true}
          .maskClosable=${Boolean(relayId)}
          @close=${() => this.#s({ settingsOpen: false })}
        >
          <agent-relay-settings
            class="block w-[calc(100vw-2rem)] max-w-md"
            .value=${relayId}
            @confirm=${this.#connectRelay}
          ></agent-relay-settings>
        </agent-modal>
      </div>
    `;
  };
}
