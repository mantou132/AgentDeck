import type { MarkedExtension } from '@gem-bind/marked';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { markdownExtensions, markdownStyle, userMarkdownExtensions, userMarkdownStyle } from '../lib/markdown';
import { nextStreamingText, STREAM_REVEAL_INTERVAL } from '../lib/stream-text';

@customElement('deck-stream-markdown')
@adoptedStyle(blockContainer)
export class DeckStreamMarkdownElement extends GemElement {
  @property text = '';
  @property streamKey = '';
  @property mdStyle?: CSSStyleSheet;
  @property extensions?: MarkedExtension[];
  @boolattribute streaming: boolean;
  @boolattribute user: boolean;

  #streamText = createState({ key: undefined as string | undefined, text: '' });
  #streamTimer: number | ReturnType<typeof setTimeout> = 0;

  @memo((i) => [i.streamKey, i.streaming, i.text])
  #updateStreamingText = () => {
    clearTimeout(this.#streamTimer);
    const targetText = this.text || '';
    if (!this.streaming) {
      this.#streamText({ key: this.streamKey, text: targetText });
      return;
    }
    if (this.#streamText.key !== this.streamKey) {
      this.#streamText({ key: this.streamKey, text: '' });
    } else if (!targetText.startsWith(this.#streamText.text)) {
      this.#streamText({ text: targetText });
      return;
    }

    const reveal = () => {
      const target = this.text || '';
      const text = nextStreamingText(this.#streamText.text, target);
      if (text === this.#streamText.text) return;
      this.#streamText({ text });
      if (text !== target) this.#streamTimer = setTimeout(reveal, STREAM_REVEAL_INTERVAL);
    };
    reveal();
    return () => clearTimeout(this.#streamTimer);
  };

  @unmounted()
  #cleanup = () => {
    clearTimeout(this.#streamTimer);
  };

  get #displayText() {
    const targetText = this.text || '';
    return this.streaming && this.#streamText.key === this.streamKey ? this.#streamText.text : targetText;
  }

  @template()
  #render = () => html`
    <gem-bind-marked
      ?streaming=${this.streaming}
      .mdStyle=${this.mdStyle ?? (this.user ? userMarkdownStyle : markdownStyle)}
      .extensions=${this.extensions ?? (this.user ? userMarkdownExtensions : markdownExtensions)}
    >${this.#displayText}</gem-bind-marked>
  `;
}
