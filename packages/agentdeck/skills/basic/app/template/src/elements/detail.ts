import { store, toggleItem } from '../store';

/** Pushed onto the Stack; swipe from the left edge or tap back to close. */
@customElement('app-detail')
@connectStore(store)
export class AppDetailElement extends GemElement {
  @property itemId?: number;

  get #item() {
    return store.items.find((item) => item.id === this.itemId);
  }

  @template()
  #render = () => {
    const item = this.#item;
    return html`
      <tap-page class="bg-bg text-text">
        <tap-navbar slot="header" title=${item?.title ?? ''} back default-back></tap-navbar>
        <div class="p-4" v-if=${!!item}>
          <tap-cell-group
            .items=${[
              {
                label: 'Done',
                checked: item?.done,
                onChange: () => item && toggleItem(item.id),
              },
            ]}
          ></tap-cell-group>
        </div>
      </tap-page>
    `;
  };
}
