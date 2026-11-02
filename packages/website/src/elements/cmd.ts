const style = css`
  :scope {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #0a0c26;
    font: 13px var(--mono);
  }
  code {
    flex: 1;
    overflow-x: auto;
    white-space: nowrap;
  }
  code::before {
    content: "$ ";
    color: var(--cyan);
  }
  button {
    padding: 4px 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    font: 12px inherit;
    cursor: pointer;
  }
  button:hover {
    color: var(--text);
  }
`;

/** A shell command with a copy button */
@customElement('app-cmd')
@adoptedStyle(style)
export class AppCmdElement extends GemElement {
  @attribute command: string;

  #state = createState({ copied: false });

  #copy = async () => {
    await navigator.clipboard.writeText(this.command);
    this.#state({ copied: true });
    setTimeout(() => this.#state({ copied: false }), 1500);
  };

  @template()
  #content = () => html`
    <code>${this.command}</code>
    <button type="button" @click=${this.#copy}>${i18n.get(this.#state.copied ? 'copied' : 'copy')}</button>
  `;
}
