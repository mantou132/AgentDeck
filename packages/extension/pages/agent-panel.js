import { isPairingId } from 'agentdeck/agent/encryption';
import { agentApi, closeTransport } from 'agentdeck/agent/transport';
import { displayPath } from 'agentdeck/lib/path';
import { updateAgentPanelState } from '../shared/agent-session-store.js';
import { POPULAR_AGENTS } from '../shared/agents.js';
import { setPageI18n, t } from '../shared/i18n.js';
import {
  mountAgentApi,
  mountBootstrap,
  mountCompactMode,
  mountStoredState,
  startExtensionTransport,
} from './agent-panel/effects.js';
import { createSessionController } from './agent-panel/session-controller.js';
import { createSessionRuntime } from './agent-panel/session-runtime.js';
import { createTurnController } from './agent-panel/turn-controller.js';

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
  @boolattribute showEvents;

  #s = createState({
    compact: false,
    sessions: [], // persisted local records: { key, agent, sessionId, title?, cwd?, updatedAt? }
    draftSession: null, // at most one local session without an ACP session id; never persisted
    defaults: { agent: '', configOptionsByAgent: {} },
    agents: POPULAR_AGENTS, // curated popular ACP agents aligned with AgentDeck
    sessionKey: null, // unique local key of the displayed session
    messages: [], // text messages, thought blocks, tool calls, or raw events
    configOptions: [], // draft composer settings, or a live session's applied ACP options
    queue: [], // prompts staged while the displayed session has one in flight
    pendingIds: [], // local session keys with a prompt in flight
    booting: true, // initial local state loading (whole page loader)
    loadingIds: [], // local session keys being created or loaded
    deleting: null, // local session key being deleted
    error: '', // global errors (storage/delete/create), transient
    sessionErrors: {}, // per-session last error, shown when that session displays
    cwd: '',
    home: '',
    newSessionOpen: false,
    settingsOpen: false,
    relayId: '',
    permissions: {}, // per-session outstanding permission request: local key -> request
  });

  #chatPaneRef = createRef();
  #runtime = createSessionRuntime(this.#s);
  #turns = createTurnController({
    state: this.#s,
    runtime: this.#runtime,
    api: agentApi,
    scrollToLatest: () => this.#chatPaneRef.value?.scrollToLatest(true),
    startDraftTurn: (...args) => this.#sessions.startDraftTurn(...args),
  });
  #sessions = createSessionController({
    state: this.#s,
    runtime: this.#runtime,
    turns: this.#turns,
    api: agentApi,
  });

  @effect(() => [])
  #bootstrap = () => mountBootstrap({ state: this.#s });

  @effect(() => [])
  #observeStoredState = () => mountStoredState(this.#s);

  @effect(() => [])
  #observeCompactMode = () => mountCompactMode(this.#s);

  @effect(() => [])
  #bindAgentApi = () => mountAgentApi({ sessions: this.#sessions, turns: this.#turns, state: this.#s });

  #connectRelay = async (event) => {
    const id = (event.detail || '').trim();
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
    return (this.#s.configOptions || []).filter(
      (option) => option.type === 'select' && Array.isArray(option.options) && option.options.length,
    );
  }

  get #currentAgent() {
    return this.#runtime.record(this.#s.sessionKey)?.agent || '';
  }

  get #currentTitle() {
    return this.#runtime.record(this.#s.sessionKey)?.title || t('devtoolsPanelNewSession');
  }

  get #recentCwd() {
    const timestamp = (session) => Date.parse(session.updatedAt || '') || 0;
    return (
      this.#runtime
        .list()
        .filter((session) => session.cwd)
        .reduce((recent, session) => (!recent || timestamp(session) > timestamp(recent) ? session : recent), null)
        ?.cwd || this.#s.cwd
    );
  }

  render = () => {
    const {
      compact,
      sessionKey,
      cwd,
      agents,
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
    const loadingSession = loadingIds.includes(sessionKey) && !this.#runtime.record(sessionKey)?.draft;
    const bannerError = error || (sessionKey ? sessionErrors[sessionKey] : '') || '';
    const initialAgent = agents.some((agent) => agent.id === defaults.agent) ? defaults.agent : agents[0]?.id;

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
          @select=${(e) => this.#sessions.openSession(e.detail)}
          @create=${this.#sessions.openNewSession}
          @remove=${(e) => this.#sessions.deleteSession(e.detail)}
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
          .agent=${this.#currentAgent}
          .configOptions=${this.#configSelects}
          ?turn-pending=${pendingIds.includes(sessionKey)}
          .queue=${queue}
          @send=${(e) => this.#turns.send(e.detail)}
          @cancel=${this.#turns.cancel}
          @configchange=${(e) => this.#sessions.changeConfig(e.detail.configId, e.detail.value)}
          @decision=${(e) => this.#turns.decidePermission(sessionKey, e.detail)}
          @attacherror=${(e) => this.#runtime.setError(sessionKey, e.detail)}
          @queuesend=${(e) => this.#turns.flushQueued(sessionKey, e.detail)}
          @queueupdate=${(e) => this.#turns.updateQueued(sessionKey, e.detail)}
          @queueremove=${(e) => this.#turns.removeQueued(sessionKey, e.detail)}
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
            .complete=${(value) => agentApi.completeCwd(value)}
            .initialValue=${displayPath(this.#recentCwd, home)}
            .home=${home}
            .agents=${agents}
            .initialAgent=${initialAgent}
            @confirm=${(event) => this.#sessions.confirmNewSession(event.detail)}
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
