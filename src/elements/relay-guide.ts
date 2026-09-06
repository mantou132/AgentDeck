import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer, focusStyle } from '@mantou/tap-ui/lib/styles';

import type { CarouselItem } from './carousel';

const items: CarouselItem[] = [
  {
    title: '安装浏览器扩展',
    image: 'install',
    description: html`
      在电脑浏览器中安装
      <a
        class="text-primary-strong underline decoration-primary/30 underline-offset-4"
        href="https://github.com/mantou132/browser4agent"
        target="_blank"
        rel="noopener noreferrer"
      >Browser for AI Agent</a>，并按欢迎页指引安装 Native Host。
    `,
  },
  {
    title: '复制 Relay ID',
    image: 'copy',
    description: '右键点击电脑浏览器工具栏中的扩展图标，选择「复制 relay id」，粘贴到 AgentDeck。',
  },
  {
    title: '保持浏览器开启',
    image: 'connected',
    description: 'Native Host 随电脑浏览器运行。使用 AgentDeck 时，请保持浏览器开启。',
  },
].map(({ title, image, description }) => ({
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

@customElement('deck-relay-guide')
@adoptedStyle(blockContainer)
@adoptedStyle(focusStyle)
export class DeckRelayGuideElement extends GemElement {
  @emitter close: Emitter;

  @template()
  #render = () => html`
    <deck-carousel label="获取 Relay ID 的三个步骤" .items=${items}></deck-carousel>
    <button
      class="mt-5 h-12 w-full cursor-pointer rounded-xl border-0 bg-primary text-sm font-semibold text-white transition-transform active:scale-[0.985]"
      @click=${() => this.close()}
    >
      知道了
    </button>
  `;
}
