import type { Emitter } from '@mantou/gem';
import {
  cancel as cancelScan,
  checkPermissions,
  Format,
  requestPermissions,
  scan,
} from '@tauri-apps/plugin-barcode-scanner';

export type DeckQrScannerError = 'permission-denied' | 'scan-failed';

@customElement('deck-qr-scanner')
export class DeckQrScannerElement extends GemElement {
  @attribute title: string;
  @attribute hint: string;
  @attribute cancelText: string;

  @emitter result: Emitter<string>;
  @emitter cancel: Emitter<null>;
  @emitter error: Emitter<DeckQrScannerError>;

  @template()
  #render = () => html`
    <tap-reflect .target=${document.body}>
      <style>
        html, body {
          background: transparent !important;
        }
        body *:not(deck-qr-scanner-ghost) {
          opacity: 0 !important;
        }
      </style>
      <deck-qr-scanner-ghost
        .title=${this.title}
        .hint=${this.hint}
        .cancelText=${this.cancelText}
        @result=${(e: CustomEvent) => this.result(e.detail)}
        @cancel=${(e: CustomEvent) => this.cancel(e.detail)}
        @error=${(e: CustomEvent) => this.error(e.detail)}
      ></deck-qr-scanner-ghost>
    </tap-reflect>
  `;
}

const style = css`
  :host {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: block;
    overflow: hidden;
    color: white;
  }

  .title {
    position: absolute;
    top: calc(24px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
    left: 0;
    right: 0;
    z-index: 1;
    margin: 0;
    text-align: center;
    font-size: 17px;
    font-weight: 600;
  }

  .frame {
    position: absolute;
    top: 45%;
    left: 50%;
    width: min(72vw, 300px);
    aspect-ratio: 1;
    transform: translate(-50%, -50%);
    border-radius: 12px;

    /* 框外遮罩，框内保持透明，可以看到原生 Camera */
    box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.5);
  }

  .frame::before {
    content: '';
    position: absolute;
    inset: 0;
    border: 1px solid rgb(255 255 255 / 0.3);
    border-radius: inherit;
  }

  .corner {
    position: absolute;
    width: 28px;
    height: 28px;
    border-color: white;
    border-style: solid;
    border-width: 0;
  }

  .corner-tl {
    top: 0;
    left: 0;
    border-top-width: 3px;
    border-left-width: 3px;
    border-radius: 12px 0 0 0;
  }

  .corner-tr {
    top: 0;
    right: 0;
    border-top-width: 3px;
    border-right-width: 3px;
    border-radius: 0 12px 0 0;
  }

  .corner-bl {
    bottom: 0;
    left: 0;
    border-bottom-width: 3px;
    border-left-width: 3px;
    border-radius: 0 0 0 12px;
  }

  .corner-br {
    right: 0;
    bottom: 0;
    border-right-width: 3px;
    border-bottom-width: 3px;
    border-radius: 0 0 12px 0;
  }

  .hint {
    position: absolute;
    top: calc(45% + min(36vw, 150px) + 24px);
    left: 24px;
    right: 24px;
    z-index: 1;
    margin: 0;
    text-align: center;
    font-size: 14px;
    color: rgb(255 255 255 / 0.8);
  }

  .cancel {
    position: absolute;
    right: 24px;
    bottom: calc(24px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
    left: 24px;
    z-index: 1;
    height: 50px;
    border: 0;
    border-radius: 16px;
    background: rgb(255 255 255 / 0.18);
    color: white;
    font-size: 16px;
    font-weight: 600;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    transition: transform 0.1s ease;
  }

  .cancel:active {
    background: rgb(255 255 255 / 0.28);
    transform: scale(0.98);
  }
`;

@customElement('deck-qr-scanner-ghost')
@shadow()
@adoptedStyle(style)
export class DeckQrScannerGhostElement extends DeckQrScannerElement {
  @mounted()
  #start = async () => {
    try {
      let permission = await checkPermissions();
      if (permission !== 'granted') permission = await requestPermissions();
      if (permission !== 'granted') {
        this.error('permission-denied');
        return;
      }
      const { content } = await scan({ formats: [Format.QRCode], cameraDirection: 'back', windowed: true });
      this.result(content);
    } catch (err) {
      if (err?.message !== 'cancelled') this.error('scan-failed');
    }
  };

  @unmounted()
  #mounted = () => {
    cancelScan().catch(() => {});
  };

  #close = async () => {
    await cancelScan().catch(() => {});
    this.cancel(null);
  };

  @template()
  #render = () => html`
    <h1 v-if=${this.title} class="title">${this.title}</h1>
    <div class="frame">
      <span class="corner corner-tl"></span>
      <span class="corner corner-tr"></span>
      <span class="corner corner-bl"></span>
      <span class="corner corner-br"></span>
    </div>
    <p v-if=${this.hint} class="hint">${this.hint}</p>
    <button v-if=${this.cancelText} class="cancel" type="button" @click=${this.#close}>
      ${this.cancelText}
    </button>
  `;
}
