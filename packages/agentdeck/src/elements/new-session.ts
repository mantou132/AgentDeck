import type { Emitter } from '@mantou/gem/lib/decorators';
import { i18n } from '../i18n';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

type NewSessionProposal = { title: string; prompt: string };

/** Body of an `agentdeck-session` fenced block, as taught by the host's session skill. */
const parseProposal = (source: string): NewSessionProposal | undefined => {
  try {
    const { title, prompt } = JSON.parse(source);
    if (typeof prompt === 'string' && prompt.trim()) return { title: typeof title === 'string' ? title : '', prompt };
  } catch {}
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
  .card:active {
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

/** A follow-up task the agent proposes; tapping it starts a new session in the same place with its prompt. */
@customElement('deck-new-session')
@adoptedStyle(style)
@shadow()
export class DeckNewSessionElement extends GemElement {
  @attribute source: string;
  /** Prompt for the session page to send in a new session. */
  @globalemitter newSession: Emitter<string>;

  @memo((i) => [i.source])
  get #proposal() {
    return parseProposal(this.source);
  }

  @template()
  #render = () => {
    const proposal = this.#proposal;
    // Invalid JSON stays readable as the original block.
    if (!proposal) return html`<pre>${this.source}</pre>`;
    const { title, prompt } = proposal;
    return html`
      <button class="card" type="button" @click=${() => this.newSession(prompt)}>
        <tap-use .element=${icons.add}></tap-use>
        <div class="text">
          <div class="title">${title || i18n.get('session.newSession')}</div>
          <div class="prompt">${prompt}</div>
        </div>
        <span class="start">${i18n.get('newSession.start')}</span>
      </button>
    `;
  };
}
