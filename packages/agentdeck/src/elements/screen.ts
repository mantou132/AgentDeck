import { createDecoratorTheme } from '@mantou/gem/helper/theme';
import { polling } from '@mantou/tap-ui/lib/timer';
import type { ScreenCapture } from '../agent/api';
import { agentApi } from '../agent/transport';
import { i18n } from '../i18n';
import { openScreen } from '../navigation';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

/** Pause between live frames; `polling` waits for each reply first, so slow links simply drop frames. */
const FRAME_INTERVAL = 300;

type ScreenShot = ScreenCapture & { src: string };

/** Latest frame per target, shared by the cards and the live page. */
const screenStore = createStore({ shots: {} as Record<string, ScreenShot | undefined> });

const captureScreen = async (target: string, maxWidth: number) => {
  const { data, ...capture } = await agentApi.captureScreen(target, Math.round(maxWidth * devicePixelRatio));
  const previous = screenStore.shots[target];
  const src = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
  screenStore({ shots: { ...screenStore.shots, [target]: { ...capture, src } } });
  if (previous) URL.revokeObjectURL(previous.src);
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const parseTarget = (target: string) => {
  const [kind, ...rest] = target.trim().split(':');
  return { kind, id: rest.join(':') };
};

const targetName = (target: string, shot?: ScreenShot) => {
  if (shot?.frame.kind === 'browser') return shot.frame.title || shot.frame.url;
  const { kind } = parseTarget(target);
  if (kind === 'ios') return i18n.get('screen.ios');
  if (kind === 'android') return i18n.get('screen.android');
  return i18n.get('screen.browser');
};

const cardStyle = css`
  :host {
    display: block;
    margin-block: 0.75em;
  }
  .card {
    position: relative;
    display: block;
    width: 100%;
    height: 12rem;
    padding: 0;
    overflow: hidden;
    border: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.lightBackgroundColor};
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .shot {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top;
  }
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    height: 100%;
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
  .placeholder tap-use {
    width: 1.25rem;
  }
  .bar {
    position: absolute;
    inset: auto 0 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-top: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
    background: ${agentDeckTheme.lightBackgroundColor};
  }
  .bar tap-use {
    flex-shrink: 0;
    width: 1.5rem;
    color: ${agentDeckTheme.primaryColor};
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .name,
  .id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    color: ${agentDeckTheme.highlightColor};
    font-weight: 600;
  }
  .id {
    color: ${agentDeckTheme.describeColor};
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
  .open {
    flex-shrink: 0;
    color: ${agentDeckTheme.primaryStrongColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
  }
`;

/** Body of an `agentdeck-screen` fenced block: a screen target, as taught by the host's screen skill. */
@customElement('deck-screen')
@adoptedStyle(cardStyle)
@connectStore(screenStore)
@shadow()
export class DeckScreenElement extends GemElement {
  @attribute target: string;

  #state = createState({ error: '' });

  get #target() {
    return this.target.trim();
  }

  // One frame as the background, captured once the card scrolls into view.
  @effect(() => [])
  #observe = () => {
    const observer = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      try {
        await captureScreen(this.#target, this.clientWidth);
      } catch (error) {
        this.#state({ error: errorMessage(error) });
      }
    });
    observer.observe(this);
    return () => observer.disconnect();
  };

  @template()
  #render = () => {
    const target = this.#target;
    const shot = screenStore.shots[target];
    const { kind, id } = parseTarget(target);
    const subtitle = shot?.frame.kind === 'browser' ? shot.frame.url : id;
    return html`
      <button class="card" type="button" title=${this.#state.error} @click=${() => openScreen(target)}>
        <img v-if=${!!shot} class="shot" src=${shot?.src} alt="" />
        <div v-else class="placeholder">
          <tap-use v-if=${!this.#state.error} .element=${icons.loading}></tap-use>
          ${this.#state.error ? i18n.get('screen.unavailable') : i18n.get('screen.loading')}
        </div>
        <div class="bar">
          <tap-use .element=${kind === 'browser' ? icons.globe : icons.smartphone}></tap-use>
          <div class="text">
            <div class="name">${targetName(target, shot)}</div>
            <div class="id">${subtitle}</div>
          </div>
          <span class="open">${i18n.get('screen.open')}</span>
        </div>
      </button>
    `;
  };
}

const deviceTheme = createDecoratorTheme({ ratio: '1', corner: '0' });

/** Corner of a phone-emulating browser tab, which reports no screen shape; close to a current iPhone. */
const EMULATED_PHONE_CORNER = 0.13;

const deviceStyle = css`
  :host {
    display: block;
    width: 100%;
    height: 100%;
    container-type: size;
  }
  .stage {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }
  img {
    display: block;
    width: 100%;
    aspect-ratio: ${deviceTheme.ratio};
  }
  .phone {
    --bezel: 0.625rem;
    /* Largest screen width that fits the page with its bezel. */
    --w: min(calc(100cqw - 2rem - 2 * var(--bezel)), calc((100cqh - 2rem - 2 * var(--bezel)) * ${deviceTheme.ratio}));
    padding: var(--bezel);
    border-radius: max(calc(var(--w) * ${deviceTheme.corner} + var(--bezel)), 1.75rem);
    background: #111;
    box-shadow:
      inset 0 0 0 1px #3a3a3c,
      0 0.75rem 2.5rem rgb(0 0 0 / 0.3);
  }
  .screen {
    position: relative;
    width: var(--w);
    overflow: hidden;
    border-radius: calc(var(--w) * ${deviceTheme.corner});
    background: #000;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .window {
    --bar: 2.25rem;
    width: min(calc(100cqw - 2rem), calc((100cqh - 2rem - var(--bar)) * ${deviceTheme.ratio}));
    overflow: hidden;
    border: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
    border-radius: 0.75rem;
    background: ${agentDeckTheme.lightBackgroundColor};
    box-shadow: 0 0.75rem 2.5rem rgb(0 0 0 / 0.2);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    height: var(--bar);
    padding-inline: 0.75rem;
    border-bottom: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
  }
  .dots {
    display: flex;
    gap: 0.375rem;
  }
  .dots i {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: ${agentDeckTheme.borderColor};
  }
  .url {
    flex: 1;
    min-width: 0;
    padding: 0.125rem 0.625rem;
    overflow: hidden;
    border-radius: 999px;
    background: ${agentDeckTheme.backgroundColor};
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

/** A capture inside its device: a phone body following the screen's own shape (phone-emulating tabs included), or a browser window. */
@customElement('deck-screen-device')
@adoptedStyle(deviceStyle)
@shadow()
export class DeckScreenDeviceElement extends GemElement {
  @property shot?: ScreenShot;

  @deviceTheme((i: DeckScreenDeviceElement) => [i.shot?.width, i.shot?.height, i.shot?.frame])
  #theme = () => {
    const { width = 1, height = 1, frame } = this.shot || {};
    const corner = frame?.kind === 'phone' ? frame.cornerRadius / width : frame?.mobile ? EMULATED_PHONE_CORNER : 0;
    return { ratio: String(width / height), corner: String(corner) };
  };

  @template()
  #render = () => {
    const shot = this.shot;
    if (!shot) return html``;
    const { frame } = shot;
    if (frame.kind === 'browser' && !frame.mobile) {
      return html`
        <div class="stage">
          <div class="window">
            <div class="bar">
              <span class="dots"><i></i><i></i><i></i></span>
              <span class="url" title=${frame.url}>${frame.url || frame.title}</span>
            </div>
            <img src=${shot.src} alt=${frame.title} />
          </div>
        </div>
      `;
    }
    const cutouts = frame.kind === 'phone' ? frame.cutouts : undefined;
    return html`
      <div class="stage">
        <div class="phone">
          <div class="screen">
            <img src=${shot.src} alt="" />
            <svg v-if=${!!cutouts} viewBox="0 0 ${shot.width} ${shot.height}" aria-hidden="true">
              ${cutouts?.map(({ path, transform }) => svg`<path d=${path} transform=${transform}></path>`)}
            </svg>
          </div>
        </div>
      </div>
    `;
  };
}

const pageStyle = css`
  :scope {
    height: 100%;
  }
  footer {
    height: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  }
`;

/** Live view: polls frames while open; leaving the page ends the loop, so the host keeps no capture state. */
@customElement('deck-screen-page')
@adoptedStyle(pageStyle)
@connectStore(screenStore)
export class DeckScreenPageElement extends GemElement {
  @property target = '';

  #state = createState({ error: '', revision: 0 });

  #retry = () => this.#state({ error: '', revision: this.#state.revision + 1 });

  @effect((i) => [i.target, i.#state.revision])
  #live = () => {
    const stop = polling(async () => {
      if (document.hidden) return;
      try {
        await captureScreen(this.target, Math.min(innerWidth, 1024));
      } catch (error) {
        stop();
        this.#state({ error: errorMessage(error) });
      }
    }, FRAME_INTERVAL);
    return stop;
  };

  @template()
  #render = () => {
    const { error } = this.#state;
    const shot = screenStore.shots[this.target];
    return html`
      <tap-page class="bg-bg text-text">
        <tap-navbar slot="header" title=${targetName(this.target, shot)} back default-back></tap-navbar>
        <main class="relative h-full overflow-hidden">
          <deck-screen-device v-if=${!!shot} class=${error ? 'opacity-40' : ''} .shot=${shot}></deck-screen-device>
          <div
            v-else-if=${!error}
            role="status"
            class="flex h-full items-center justify-center gap-2 text-sm text-describe"
          >
            <tap-use class="size-5 text-primary" .element=${icons.loading}></tap-use>
            ${i18n.get('screen.loading')}
          </div>
          <div v-if=${!!error} role="alert" class="absolute inset-0 flex flex-col items-center justify-center px-5 text-center">
            <tap-use class="mb-3 size-8 text-negative" .element=${icons.error}></tap-use>
            <p class="m-0 font-semibold text-highlight">${i18n.get('screen.failed')}</p>
            <p class="select-text mt-2 max-w-lg text-sm break-words text-negative">${error}</p>
            <button
              class="mt-4 min-h-11 cursor-pointer rounded-xl border border-primary/20 bg-primary-soft px-5 text-sm font-semibold text-primary-strong active:scale-[0.98]"
              @click=${this.#retry}
            >
              ${i18n.get('global.retry')}
            </button>
          </div>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
