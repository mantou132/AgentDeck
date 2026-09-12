import type { TemplateResult } from '@mantou/gem';
import type { Emitter } from '@mantou/gem/lib/decorators';
import { contentsContainer } from '@mantou/tap-ui/lib/styles';
import { agentDeckTheme } from '../styles/theme';

const layerStyle = css`
  tap-sheet::part(sheet) {
    max-width: 620px;
    border: 1px solid ${agentDeckTheme.borderColor};
    border-bottom: 0;
    border-radius: 24px 24px 0 0;
    background: ${agentDeckTheme.lightBackgroundColor};
    padding: 0 20px calc(20px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }

  tap-sheet::part(header) {
    padding: 4px 0 20px;
  }
`;

// Keep the scoped styles attached to the content reflected into document.body.
@customElement('deck-sheet-layer')
@adoptedStyle(contentsContainer)
@adoptedStyle(layerStyle)
class DeckSheetLayerElement extends GemElement {
  @property content?: TemplateResult;

  @template()
  #render = () => this.content;
}

@customElement('deck-sheet')
@adoptedStyle(contentsContainer)
export class DeckSheetElement extends GemElement {
  @boolattribute open: boolean;
  @property heading = '';
  @property description = '';
  @property content?: TemplateResult;
  @emitter close: Emitter;

  @template()
  #render = () => html`
    <tap-reflect .target=${document.body}>
      <deck-sheet-layer .content=${html`
        <tap-sheet
          ?open=${this.open}
          header=${this.heading}
          gesture
          mask-closable
          @close=${() => this.close()}
        >
          <div slot="header" class="pt-1.5 text-center">
            <h2 class="m-0 break-words font-display text-lg leading-snug font-semibold tracking-tight text-highlight">${this.heading}</h2>
            <p v-if=${this.description} class="mt-1.5 mb-0 text-sm leading-relaxed font-normal text-describe">${this.description}</p>
          </div>
          ${this.content}
        </tap-sheet>
      `}></deck-sheet-layer>
    </tap-reflect>
  `;
}
