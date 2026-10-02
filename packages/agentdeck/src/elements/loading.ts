import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { icons } from '../styles/icons';

/** 整页加载状态，位置与 `deck-error` 对齐 */
@customElement('deck-loading')
@adoptedStyle(blockContainer)
@aria({ role: 'status' })
export class DeckLoadingElement extends GemElement {
  @attribute label: string;

  @template()
  #render = () => html`
    <div class="flex items-center justify-center gap-2 px-4 py-16 text-sm text-describe">
      <tap-use class="size-5 text-primary" .element=${icons.loading}></tap-use>
      ${this.label}
    </div>
  `;
}
