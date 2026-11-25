import { createDecoratorTheme } from '@mantou/gem/helper/theme';
import type { Emitter } from '@mantou/gem/lib/decorators';
import { AXIS_LOCK_SLOP, type EndEventDetail, type TapGestureElement } from '@mantou/tap-ui/elements/gesture';
import { Toast } from '@mantou/tap-ui/elements/toast';
import type { ScreenCapture } from 'src/agent/api';
import { agentApi } from 'src/agent/transport';
import { i18n } from 'src/i18n';
import { hapticImpact } from 'src/lib/haptics';
import { openScreen } from 'src/navigation';
import { agentdeckStore } from 'src/state/store';
import { icons } from 'src/styles/icons';
import { agentDeckTheme, pageStyle } from 'src/styles/theme';

type ScreenShot = ScreenCapture & { src: string };
export type ScreenTap = { x: number; y: number };

/** Latest frame per target, shared by the cards and the live page. */
const screenStore = createStore({ shots: {} as Record<string, ScreenShot | undefined> });

const setScreenFrame = (target: string, capture: ScreenCapture & { data: Uint8Array<ArrayBuffer> }) => {
  const { data, ...info } = capture;
  const previous = screenStore.shots[target];
  const src = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
  screenStore({ shots: { ...screenStore.shots, [target]: { ...info, src } } });
  if (previous) URL.revokeObjectURL(previous.src);
};

const captureScreen = async (target: string, maxWidth: number) => {
  const capture = await agentApi.captureScreen(target, Math.round(maxWidth * devicePixelRatio));
  setScreenFrame(target, capture);
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
    box-sizing: border-box;
    overflow: hidden;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    height: 12rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .shot {
    width: 100%;
    height: 0;
    flex: 1;
    object-fit: cover;
    object-position: top;
  }
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    flex: 1;
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
  .placeholder tap-use {
    width: 1.25rem;
  }
  .bar {
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
        await captureScreen(this.#target, this.clientWidth || 320);
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

const exceededTapSlop = (moves: readonly { x: number; y: number }[]) => {
  let dx = 0;
  let dy = 0;
  for (const move of moves) {
    dx += move.x;
    dy += move.y;
    if (Math.hypot(dx, dy) > AXIS_LOCK_SLOP) return true;
  }
  return false;
};

const supportsTap = (target: string) => {
  const { kind } = parseTarget(target);
  return kind === 'android' || kind === 'browser';
};

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
    pointer-events: none;
    user-select: none;
    -webkit-user-drag: none;
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
    cursor: pointer;
  }
  .viewport {
    position: relative;
    overflow: hidden;
    cursor: pointer;
  }
  .ripple {
    position: absolute;
    left: 0;
    top: 0;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: rgb(255 255 255 / 0.45);
    box-shadow: 0 0 0 1.5px rgb(0 0 0 / 0.25);
    opacity: 0;
    pointer-events: none;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
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
  @emitter tap: Emitter<ScreenTap>;

  #rippleRef = createRef<HTMLSpanElement>();
  #multiTouch = false;

  #preventDefault = (evt: Event) => evt.preventDefault();

  #onMultiTouch = () => {
    this.#multiTouch = true;
  };

  #showRipple = (x: number, y: number) => {
    const el = this.#rippleRef.value;
    if (!el) return;
    for (const animation of el.getAnimations()) animation.cancel();
    const left = `${x * 100}%`;
    const top = `${y * 100}%`;
    el.animate(
      [
        { left, top, transform: 'translate(-50%, -50%) scale(0.35)', opacity: 0.85 },
        { left, top, transform: 'translate(-50%, -50%) scale(1.6)', opacity: 0 },
      ],
      { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  };

  #onEnd = (evt: CustomEvent<EndEventDetail>) => {
    const multiTouch = this.#multiTouch;
    this.#multiTouch = false;
    const { event, pressed } = evt.detail;
    if (multiTouch || pressed || event.type !== 'pointerup' || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const gesture = evt.currentTarget as TapGestureElement;
    const moves = gesture.movesMap.get(event.pointerId);
    if (moves && exceededTapSlop(moves)) return;

    const rect = gesture.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;

    this.#showRipple(x, y);
    this.tap({ x, y });
  };

  @deviceTheme((i: DeckScreenDeviceElement) => [
    i.shot?.width,
    i.shot?.height,
    i.shot?.frame.kind === 'phone' ? i.shot.frame.cornerRadius : i.shot?.frame.mobile,
  ])
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
            <tap-gesture
              class="viewport"
              @end=${this.#onEnd}
              @pinch=${this.#onMultiTouch}
              @contextmenu=${this.#preventDefault}
            >
              <img src=${shot.src} alt=${frame.title} />
              <span ${this.#rippleRef} class="ripple" aria-hidden="true"></span>
            </tap-gesture>
          </div>
        </div>
      `;
    }
    const cutouts = frame.kind === 'phone' ? frame.cutouts : undefined;
    return html`
      <div class="stage">
        <div class="phone">
          <tap-gesture
            class="screen"
            @end=${this.#onEnd}
            @pinch=${this.#onMultiTouch}
            @contextmenu=${this.#preventDefault}
          >
            <img src=${shot.src} alt="" />
            <svg v-if=${!!cutouts} viewBox="0 0 ${shot.width} ${shot.height}" aria-hidden="true">
              ${cutouts?.map(({ path, transform }) => svg`<path d=${path} transform=${transform}></path>`)}
            </svg>
            <span ${this.#rippleRef} class="ripple" aria-hidden="true"></span>
          </tap-gesture>
        </div>
      </div>
    `;
  };
}

/** Live view: streams frames while open and visible, stops when hidden or left, and resumes automatically on reconnect. */
@customElement('deck-screen-page')
@adoptedStyle(pageStyle)
@connectStore(screenStore)
@connectStore(agentdeckStore)
export class DeckScreenPageElement extends GemElement {
  @property target = '';

  #state = createState({ error: '', revision: 0, deferFrame: false, entered: false });

  #retry = () => this.#state({ error: '', revision: this.#state.revision + 1 });

  #onTap = async (evt: CustomEvent<ScreenTap>) => {
    if (!this.target || this.#state.error || agentdeckStore.connection !== 'connected') return;
    if (!supportsTap(this.target)) return;
    hapticImpact('light');
    try {
      await agentApi.tapScreen(this.target, evt.detail.x, evt.detail.y);
    } catch (error) {
      Toast.open('error', errorMessage(error));
    }
  };

  // When there is no cached frame, the initial frame may arrive midway through enter animation; wait until animation completes before displaying device frame. Existing cached frames are displayed immediately
  @effect((i) => [i.target])
  #checkCache = () => this.#state({ deferFrame: !screenStore.shots[this.target] });

  @effect((i) => [i.target, i.#state.revision, agentdeckStore.connection === 'connected'])
  #live = () => {
    const target = this.target;
    if (!target || agentdeckStore.connection !== 'connected') return;

    let stopped = false;
    const maxWidth = Math.round(Math.min(innerWidth, 1024) * devicePixelRatio);

    const stopOnHost = () => {
      if (agentdeckStore.connection === 'connected') {
        agentApi.stopStreamScreen(target).catch(() => {});
      }
    };

    const runStream = async () => {
      if (document.hidden || stopped || agentdeckStore.connection !== 'connected') return;
      this.#state({ error: '' });
      try {
        await agentApi.streamScreen(target, maxWidth, (frame) => {
          if (!stopped && !document.hidden) setScreenFrame(target, frame);
        });
      } catch (error) {
        if (stopped || document.hidden || agentdeckStore.connection !== 'connected') return;
        stopOnHost();
        this.#state({ error: errorMessage(error) });
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopOnHost();
      } else if (!stopped) {
        runStream();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    runStream();

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopOnHost();
    };
  };

  @template()
  #render = () => {
    const { error, deferFrame, entered } = this.#state;
    const shot = screenStore.shots[this.target];
    const showShot = !!shot && (!deferFrame || entered);
    return html`
      <tap-page class="bg-bg text-text" .trackVisibility=${false} @full-show=${() => this.#state({ entered: true })}>
        <tap-navbar slot="header" title=${targetName(this.target, shot)} back default-back></tap-navbar>
        <main class="relative h-full overflow-hidden">
          <deck-screen-device
            v-if=${showShot}
            class=${error ? 'opacity-40' : ''}
            .shot=${shot}
            @tap=${this.#onTap}
          ></deck-screen-device>
          <deck-loading v-else-if=${!error} label=${i18n.get('screen.loading')}></deck-loading>
          <deck-error
            v-if=${!!error}
            class="absolute inset-x-0 top-0"
            heading=${i18n.get('screen.failed')}
            error=${error}
            @retry=${this.#retry}
          ></deck-error>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
