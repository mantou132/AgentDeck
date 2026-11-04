import type { Emitter } from '@mantou/gem/lib/decorators';
import { i18n } from '../i18n';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

/** `cwd` is the directory the agent asked for; without it the session page picks one. */
export type NewSessionProposal = { title: string; prompt: string; cwd?: string };

/** Body of an `agentdeck-session` fenced block, as taught by the host's session skill. */
const parseProposal = (source: string): NewSessionProposal | undefined => {
  try {
    const { title, prompt, cwd } = JSON.parse(source);
    if (typeof prompt === 'string' && prompt.trim())
      return {
        title: typeof title === 'string' ? title : '',
        prompt,
        cwd: typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined,
      };
  } catch {}
};

/** Prompts already started, so a card stays disabled after the user returns from the session it opened. */
const startedStore = createStore({ prompts: new Set<string>() });

export const markSessionProposalStarted = (prompt: string) => {
  startedStore({ prompts: new Set(startedStore.prompts).add(prompt) });
};

const style = css`
  :host {
    display: block;
    box-sizing: border-box;
    overflow: hidden;
  }
  .card {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .card:disabled {
    cursor: default;
  }
  .card:disabled .start {
    color: ${agentDeckTheme.describeColor};
  }
  .card:not(:disabled):active {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
  tap-use {
    flex-shrink: 0;
    width: 1.5rem;
    color: ${agentDeckTheme.primaryColor};
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title {
    color: ${agentDeckTheme.highlightColor};
    font-weight: 600;
  }
  .cwd {
    overflow: hidden;
    color: ${agentDeckTheme.describeColor};
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prompt {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .start {
    flex-shrink: 0;
    align-self: center;
    color: ${agentDeckTheme.primaryStrongColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
  }
  pre {
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
`;

/** A follow-up task the agent proposes; tapping it starts a new session with its prompt. */
@customElement('deck-new-session')
@adoptedStyle(style)
@connectStore(startedStore)
@shadow()
export class DeckNewSessionElement extends GemElement {
  @attribute source: string;
  /** Proposal for the session page to start a new session with. */
  @globalemitter newSession: Emitter<NewSessionProposal>;

  @memo((i) => [i.source])
  get #proposal() {
    return parseProposal(this.source);
  }

  @template()
  #render = () => {
    const proposal = this.#proposal;
    // Invalid JSON stays readable as the original block.
    if (!proposal) return html`<pre>${this.source}</pre>`;
    const { title, prompt, cwd } = proposal;
    const started = startedStore.prompts.has(prompt);
    return html`
      <button class="card" type="button" ?disabled=${started} @click=${() => this.newSession(proposal)}>
        <tap-use .element=${icons.add}></tap-use>
        <div class="text">
          <div class="title">${title || i18n.get('session.newSession')}</div>
          <div class="cwd" v-if=${!!cwd}>${cwd}</div>
          <div class="prompt">${prompt}</div>
        </div>
        <span class="start">${i18n.get(started ? 'newSession.started' : 'newSession.start')}</span>
      </button>
    `;
  };
}
