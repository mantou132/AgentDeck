import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer, focusStyle } from '@mantou/tap-ui/lib/styles';

import { i18n } from '../i18n';
import type { CarouselItem } from './carousel';

@customElement('deck-relay-guide')
@adoptedStyle(blockContainer)
@adoptedStyle(focusStyle)
export class DeckRelayGuideElement extends GemElement {
  @emitter close: Emitter;

  get #items(): CarouselItem[] {
    return [
      {
        title: i18n.get('relayGuide.step1Title'),
        image: 'install',
        description: html`
          ${i18n.get('relayGuide.step1DescPre')}<a
            class="text-primary-strong underline decoration-primary/30 underline-offset-4"
            href="https://github.com/mantou132/browser4agent"
            target="_blank"
            rel="noopener noreferrer"
          >Browser for AI Agent</a>${i18n.get('relayGuide.step1DescPost')}
        `,
      },
      {
        title: i18n.get('relayGuide.step2Title'),
        image: 'copy',
        description: i18n.get('relayGuide.step2Desc'),
      },
      {
        title: i18n.get('relayGuide.step3Title'),
        image: 'connected',
        description: i18n.get('relayGuide.step3Desc'),
      },
    ].map(({ title, image, description }) => ({
      label: title,
      content: html`
        <div class="text-center">
          <img
            class="mx-auto block h-[clamp(128px,24dvh,220px)] w-auto max-w-full rounded-xl object-contain"
            src=${`/relay-guide/${image}.png`}
            alt=""
            width="1536"
            height="1024"
            draggable="false"
          />
          <h3 class="mt-5 mb-2 font-display text-xl font-semibold text-highlight">${title}</h3>
          <p class="mx-auto my-0 max-w-80 text-sm leading-relaxed text-describe">${description}</p>
        </div>
      `,
    }));
  }

  @template()
  #render = () => html`
    <deck-carousel label=${i18n.get('relayGuide.carouselLabel')} .items=${this.#items}></deck-carousel>
    <button
      class="mt-5 h-12 w-full cursor-pointer rounded-xl border-0 bg-primary text-sm font-semibold text-white transition-transform active:scale-[0.985]"
      @click=${() => this.close()}
    >
      ${i18n.get('relayGuide.gotIt')}
    </button>
  `;
}
