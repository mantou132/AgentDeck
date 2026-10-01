import type { EChartsOption } from '@gem-bind/echarts';
import { agentDeckTheme } from '../styles/theme';

/** Body of an `agentdeck-chart` fenced block: an ECharts option, as taught by the host's chart skill. */
const parseOption = (source: string): EChartsOption | undefined => {
  try {
    const option = JSON.parse(source);
    if (option && typeof option === 'object' && !Array.isArray(option)) return option;
  } catch {}
};

const style = css`
  :host {
    display: block;
    margin-block: 0.75em;
    padding: 0.75rem;
    border: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.lightBackgroundColor};
  }
  gem-bind-echarts {
    height: 300px;
  }
  pre {
    margin: 0;
    overflow: auto;
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
`;

@customElement('deck-chart')
@adoptedStyle(style)
@shadow()
export class DeckChartElement extends GemElement {
  @attribute source: string;

  #state = createState({ loaded: false });

  @memo((i) => [i.source])
  get #option() {
    const option = parseOption(this.source);
    // The card already provides the background, including the dark theme's.
    return option && { ...option, backgroundColor: 'transparent' };
  }

  // ECharts is large, so it loads only once a chart appears.
  @mounted()
  #load = async () => {
    await import('@gem-bind/echarts');
    this.#state({ loaded: true });
  };

  @template()
  #render = () => {
    const option = this.#option;
    // Invalid JSON stays readable as the original block.
    if (!option) return html`<pre>${this.source}</pre>`;
    return html`<gem-bind-echarts v-if=${this.#state.loaded} .option=${option}></gem-bind-echarts>`;
  };
}
