import { connect } from '@mantou/gem';
import { Sheet } from '@mantou/tap-ui/elements/sheet';
import { Stack } from '@mantou/tap-ui/elements/stack';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { i18n } from '../i18n';
import { markdownStyle, unfoldedMarkdownExtensions } from '../lib/markdown';
import { openMessageLink } from '../navigation';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

const style = css`
  :host {
    position: relative;
    display: block;
  }
  .content {
    overflow: hidden;
    max-height: 18em;
  }
  :host([size='small']) .content {
    max-height: 8.5em;
  }
  :host([disabled]) .content {
    max-height: none;
  }
  .content.masked {
    mask-image: linear-gradient(to bottom, #000 calc(100% - 3.5rem), transparent);
  }
  .view-all {
    position: absolute;
    bottom: 0.5rem;
    left: 50%;
    translate: -50%;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: 0;
    border-radius: 999px;
    padding: 0.2rem 0.75rem;
    background: color-mix(in srgb, currentColor 15%, transparent);
    color: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    backdrop-filter: blur(6px);
    box-shadow: ${agentDeckTheme.controlShadow};
  }
  .view-all:hover {
    background: color-mix(in srgb, currentColor 22%, transparent);
  }
  .view-all:active {
    scale: 0.96;
  }
  .icon {
    width: 0.75rem;
    height: 0.75rem;
  }
`;

/** 超出高度时折叠内容，通过 Sheet 查看全部；未提供 markdown 时视为 `codelang` 代码块 */
@customElement('deck-foldable')
@adoptedStyle(blockContainer)
@adoptedStyle(style)
@shadow()
export class DeckFoldableElement extends GemElement {
  /** `small` 折叠高度更低，用于用户消息 */
  @attribute size: string;
  @attribute label: string;
  @attribute codelang: string;
  /** Sheet 内链接相对该目录打开 */
  @attribute cwd: string;
  /** 不折叠，如流式输出期间 */
  @boolattribute disabled: boolean;
  @property markdown?: string;

  #contentRef = createRef<HTMLElement>();
  #state = createState({ overflowing: false });

  @effect((i) => [i.#contentRef.value])
  #observeOverflow = () => {
    const content = this.#contentRef.value;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      this.#state({ overflowing: content.scrollHeight > content.clientHeight + 1 });
    });
    observer.observe(content);
    return () => observer.disconnect();
  };

  #openDetail = (event: MouseEvent) => {
    event.stopPropagation();
    const text = this.markdown ?? this.textContent ?? '';
    const longestTicks = Math.max(0, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
    const fence = '`'.repeat(Math.max(3, longestTicks + 1));
    const result = Sheet.open({
      maskClosable: true,
      header: this.label || this.codelang.toUpperCase() || i18n.get('timeline.code'),
      body: html`
        <gem-bind-marked
          .mdStyle=${markdownStyle}
          .extensions=${unfoldedMarkdownExtensions}
          @click=${(event: MouseEvent) => openMessageLink(event, this.cwd)}
          >${this.markdown ?? `${fence}${this.codelang}\n${text}\n${fence}`}</gem-bind-marked
        >
      `,
    });
    // Sheet 盖在页面栈之上，内容触发页面栈变化（打开文件、网页、预览等）时关闭
    const { store } = Stack.instance!;
    const top = store.pages.at(-1);
    result.finally(connect(store, () => store.pages.at(-1) !== top && result.sheet.close(null)));
  };

  @template()
  #render = () => {
    const folded = !this.disabled && this.#state.overflowing;
    return html`
      <div ${this.#contentRef} class=${classMap({ content: true, masked: folded })}><slot></slot></div>
      <button v-if=${folded} type="button" class="view-all" @click=${this.#openDetail}>
        <span>${i18n.get('timeline.viewAll')}</span>
        <tap-use class="icon" .element=${icons.expand}></tap-use>
      </button>
    `;
  };
}
