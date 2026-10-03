import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { icons } from '../styles/icons';

/** Full-page loading state, aligned with `deck-error` */
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
