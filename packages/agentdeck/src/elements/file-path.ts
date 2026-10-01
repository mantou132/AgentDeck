import { blockContainer } from '@mantou/tap-ui/lib/styles';

/** 单行路径：默认保留文件名、在目录部分省略；点击切换为可横向滚动的完整路径 */
@customElement('deck-file-path')
@adoptedStyle(blockContainer)
export class DeckFilePathElement extends GemElement {
  @attribute path: string;

  #state = createState({ expanded: false });

  #toggle = () => this.#state({ expanded: !this.#state.expanded });

  @template()
  #render = () => {
    const { expanded } = this.#state;
    const index = this.path.search(/[\\/][^\\/]+[\\/]?$/);
    const head = index > 0 ? this.path.slice(0, index) : '';
    const tail = index > 0 ? this.path.slice(index) : this.path;

    return html`
      <div
        title=${this.path}
        class=${classMap({
          'flex cursor-pointer whitespace-nowrap': true,
          'no-scrollbar select-text overflow-x-auto': expanded,
        })}
        @click=${this.#toggle}
      >
        <span v-if=${expanded}>${this.path}</span>
        <span v-if=${!expanded && !!head} class="min-w-0 truncate">${head}</span>
        <span
          v-if=${!expanded}
          class=${classMap({ 'shrink-0 truncate': true, 'max-w-[70%]': !!head })}
        >
          ${tail}
        </span>
      </div>
    `;
  };
}
