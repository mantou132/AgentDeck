@customElement('agent-relay-settings')
export class AgentRelaySettingsElement extends GemElement {
  @property value;

  @emitter confirm;

  #s = createState({
    value: '',
  });

  @willMount()
  #init = () => {
    this.#s({ value: this.value || '' });
  };

  #onConfirm = () => {
    this.confirm(this.#s.value.trim());
  };

  @template()
  #content = () => {
    const { value } = this.#s;

    return html`
      <section class="w-full rounded-lg border border-border bg-bg shadow-lg">
        <header class="border-b border-border px-4 py-3">
          <h2 class="m-0 text-sm font-semibold text-highlight">AgentDeck Pairing Settings</h2>
        </header>
        <div class="px-4 py-3">
          <div class="mb-3 text-xs leading-relaxed text-describe">
            Enter the Pairing ID printed by <code>agentdeckd</code> on your computer:
          </div>
          <dy-input
            autofocus
            class="w-full font-mono"
            placeholder="adk1_..."
            .value=${value}
            @change=${(e) => this.#s({ value: e.detail })}
            @keydown=${(e) => {
              if (e.key === 'Enter') {
                this.#onConfirm();
              }
            }}
          ></dy-input>
          <div class="mt-4 flex justify-end">
            <dy-button @click=${this.#onConfirm}>Connect</dy-button>
          </div>
        </div>
      </section>
    `;
  };
}
