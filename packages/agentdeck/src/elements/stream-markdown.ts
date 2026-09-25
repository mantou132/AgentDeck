import type { MarkedExtension } from '@gem-bind/marked';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { markdownExtensions, markdownStyle, userMarkdownExtensions, userMarkdownStyle } from '../lib/markdown';
import {
  nextStreamingText,
  registerActiveStream,
  STREAM_REVEAL_INTERVAL,
  unregisterActiveStream,
} from '../lib/stream-text';

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

    if (this.#streamText.key && this.#streamText.key !== this.streamKey) {
      unregisterActiveStream(this.#streamText.key);
    }

    const isExistingStream =
      this.#streamText.key === this.streamKey &&
      this.#streamText.text.length > 0 &&
      this.#streamText.text !== targetText &&
      targetText.startsWith(this.#streamText.text);

    if (!this.streaming && !isExistingStream) {
      unregisterActiveStream(this.streamKey);
      this.#streamText({ key: this.streamKey, text: targetText });
      return;
    }

    if (this.#streamText.key !== this.streamKey) {
      this.#streamText({ key: this.streamKey, text: '' });
    } else if (!targetText.startsWith(this.#streamText.text)) {
      unregisterActiveStream(this.streamKey);
      this.#streamText({ text: targetText });
      return;
    }

    registerActiveStream(this.streamKey);

    const reveal = () => {
      const target = this.text || '';
      const text = nextStreamingText(this.#streamText.text, target);
      if (text === this.#streamText.text) {
        if (text === target) {
          unregisterActiveStream(this.streamKey);
        }
        return;
      }
      this.#streamText({ text });
      if (text !== target) {
        this.#streamTimer = setTimeout(reveal, STREAM_REVEAL_INTERVAL);
      } else {
        unregisterActiveStream(this.streamKey);
      }
    };
    reveal();
    return () => {
      clearTimeout(this.#streamTimer);
      if (this.#streamText.text === (this.text || '') || this.#streamText.key !== this.streamKey) {
        unregisterActiveStream(this.streamKey);
      }
    };
  };

  @unmounted()
  #cleanup = () => {
    clearTimeout(this.#streamTimer);
    unregisterActiveStream(this.streamKey);
  };

  get #isStreaming() {
    const targetText = this.text || '';
    const isRevealing =
      this.#streamText.key === this.streamKey &&
      this.#streamText.text.length > 0 &&
      this.#streamText.text !== targetText &&
      targetText.startsWith(this.#streamText.text);

    return (this.streaming || isRevealing) && this.#streamText.key === this.streamKey;
  }

  get #displayText() {
    return this.#isStreaming ? this.#streamText.text : this.text || '';
  }

  @template()
  #render = () => html`
    <gem-bind-marked
      class="select-text"
      ?streaming=${this.#isStreaming}
      .mdStyle=${this.mdStyle ?? (this.user ? userMarkdownStyle : markdownStyle)}
      .extensions=${this.extensions ?? (this.user ? userMarkdownExtensions : markdownExtensions)}
    >${this.#displayText}</gem-bind-marked>
  `;
}
