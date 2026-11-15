import type { Emitter } from '@mantou/gem/lib/decorators';
import { addItem } from '../store';

/** Sheet body: a form adding one item. */
@customElement('app-add-item')
export class AppAddItemElement extends GemElement {
  @emitter added: Emitter<null>;

  #state = createState({ title: '' });

  #add = () => {
    addItem(this.#state.title.trim());
    this.added(null);
  };

  @template()
  #render = () => html`
    <div class="grid gap-4 pb-2">
      <tap-input
        placeholder="Title"
        value=${this.#state.title}
        @change=${(evt: CustomEvent<string>) => this.#state({ title: evt.detail })}
      ></tap-input>
      <tap-button ?disabled=${!this.#state.title.trim()} @click=${this.#add}>Add</tap-button>
    </div>
  `;
}
