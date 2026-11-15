import { Stack } from '@mantou/tap-ui/elements/stack';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { openSheet } from '../sheet';
import { store } from '../store';

/** Root page: a list of items, each opening a detail page. */
@customElement('app-home')
@connectStore(store)
export class AppHomeElement extends GemElement {
  #add = () => {
    const close = openSheet({
      header: 'New item',
      body: html`<app-add-item
        @added=${() => {
          close();
          Toast.open('success', 'Added');
        }}
      ></app-add-item>`,
    });
  };

  #open = (id: number) => {
    Stack.push({ content: html`<app-detail .itemId=${id}></app-detail>` });
  };

  @template()
  #render = () => html`
    <tap-page class="bg-bg text-text">
      <tap-navbar slot="header" title="App"></tap-navbar>
      <div class="p-4">
        <tap-cell-group
          .items=${store.items.map((item) => ({
            label: item.title,
            description: item.done ? 'Done' : 'To do',
            action: true,
            onClick: () => this.#open(item.id),
          }))}
        ></tap-cell-group>
        <tap-button class="mt-4 w-full" @click=${this.#add}>Add item</tap-button>
      </div>
    </tap-page>
  `;
}
