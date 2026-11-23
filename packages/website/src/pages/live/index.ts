import { frameDocument } from './_frame';
import {
  type AudienceMessage,
  importKey,
  type PresenterMessage,
  type PresenterSlide,
  parseFragment,
  type RelayFrame,
  randomId,
  relayUrl,
  seal,
  unseal,
} from './_protocol';

type Status = 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'invalid' | 'unsupported';

const style = css`
  :scope {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    padding: calc(6px + env(safe-area-inset-top)) 14px 6px;
    background: var(--text);
    color: #fff;
    font-size: 13px;
  }
  .notice {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 24px;
    text-align: center;
    color: var(--muted);
  }
  .notice img {
    width: 56px;
    height: 56px;
    border-radius: 14px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.25;
    }
  }
  iframe {
    flex: 1;
    display: block;
    width: 100%;
    border: 0;
    background: #f6f7fb;
  }
  .popup {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgb(21 22 28 / 0.5);
    animation: pop 0.25s ease-out;
  }
  .popup p {
    margin: 0;
    padding: 28px 32px;
    border-radius: 20px;
    background: #fff;
    color: #1f2330;
    font-size: 26px;
    font-weight: 700;
    text-align: center;
  }
  @keyframes pop {
    from {
      opacity: 0;
    }
  }

  /* Presenter Teleprompter View */
  .prompter-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #111418;
    color: #e6edf3;
    overflow: hidden;
    position: relative;
    user-select: none;
    -webkit-user-select: none;
  }
  .prompter-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(8px + env(safe-area-inset-top)) 12px 8px;
    background: #161b22;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 13px;
    gap: 8px;
    flex-shrink: 0;
  }
  .prompter-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    color: #56d364;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .prompter-status-badge.disconnected {
    color: #f85149;
  }
  .prompter-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    color: #8b949e;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .prompter-page-text {
    font-weight: 700;
    color: #fff;
  }
  .prompter-timer-text {
    padding: 2px 6px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    cursor: pointer;
  }
  .prompter-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .prompter-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #fff;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    line-height: 1.2;
    white-space: nowrap;
  }
  .prompter-btn.wake-on {
    color: #56d364;
    background: rgba(86, 211, 100, 0.15);
  }
  .prompter-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 20px 16px 84px;
    line-height: 1.8;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }
  .prompter-body p {
    margin: 0 0 1.2em;
  }
  .prompter-body p:last-child {
    margin-bottom: 0;
  }
  .prompter-empty {
    color: #6e7681;
    font-style: italic;
    text-align: center;
    padding: 40px 0;
  }
  .cue {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: 6px;
    font-size: 0.85em;
    font-weight: 600;
    line-height: 1.3;
    margin: 0 4px;
    vertical-align: 1px;
  }
  .cue-flip {
    background: rgba(56, 139, 253, 0.2);
    border: 1px solid rgba(56, 139, 253, 0.5);
    color: #79c0ff;
  }
  .cue-pause {
    background: rgba(210, 153, 34, 0.2);
    border: 1px solid rgba(210, 153, 34, 0.5);
    color: #e3b341;
  }
  .cue-interact {
    background: rgba(46, 160, 67, 0.2);
    border: 1px solid rgba(46, 160, 67, 0.5);
    color: #56d364;
  }
  .cue-default {
    background: rgba(163, 113, 247, 0.2);
    border: 1px solid rgba(163, 113, 247, 0.5);
    color: #d2a8ff;
  }
  .prompter-nav {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    gap: 12px;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
    background: linear-gradient(to top, rgba(17, 20, 24, 0.98) 70%, transparent);
    pointer-events: auto;
  }
  .prompter-nav-btn {
    flex: 1;
    height: 50px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: #1c2128;
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .prompter-nav-btn.next {
    flex: 1.6;
    background: var(--accent);
    border-color: var(--accent);
  }
  .prompter-nav-btn:active {
    transform: scale(0.98);
  }
`;

@page({
  title: () => i18n.get('audienceTitle'),
  meta: () => ({ robots: 'noindex' }),
})
@adoptedStyle(style)
export default class LivePage extends GemElement {
  #state = createState({
    status: 'connecting' as Status,
    view: null as string | null,
    number: 0,
    popup: '',
    isPresenter: false,
    presenterConnected: false,
    currentSlide: 0,
    totalSlides: 0,
    slides: [] as PresenterSlide[],
    fontSize: 21,
    wakeLocked: false,
    elapsedSec: 0,
  });
  #frameRef = createRef<HTMLIFrameElement>();
  #bodyRef = createRef<HTMLDivElement>();
  #id = '';
  /** Presenter data waiting for the current view's frame to load. */
  #pending: unknown[] = [];
  #frameReady = false;
  #sendData?: (value: unknown) => void;
  #sendCommand?: (op: 'next' | 'prev' | 'go', index?: number) => void;
  #timerInterval?: ReturnType<typeof setInterval>;
  #wakeLockObj: WakeLockSentinel | null = null;

  @mounted()
  #start = () => {
    const fragment = parseFragment(location.hash);
    if (!fragment) return this.#state({ status: 'invalid' });
    if (!crypto.subtle) return this.#state({ status: 'unsupported' });

    const idKey = `agentdeck-live-id:${fragment.room}`;
    this.#id = localStorage.getItem(idKey) || randomId(12);
    localStorage.setItem(idKey, this.#id);

    let socket: WebSocket | undefined;
    let closed = false;
    let delay = 1000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;
    const keyPromise = importKey(fragment.key);
    /** Answers sent recently, by message id, in case the relay reports nobody received them. */
    const sent = new Map<string, unknown>();
    /** Answers that couldn't reach the presenter yet; sent again once it is there. */
    let outbox: unknown[] = [];

    // Sealing is async; a chain keeps messages in the order they were sent (a changed answer after the first one).
    let sending = Promise.resolve(true);
    const send = (message: AudienceMessage) => {
      sending = sending.then(() => sendNow(message));
      return sending;
    };
    const sendNow = async (message: AudienceMessage) => {
      const payload = await seal(await keyPromise, message);
      if (socket?.readyState !== WebSocket.OPEN) return false;
      const id = randomId(12);
      socket.send(JSON.stringify({ type: 'message', message_id: id, payload, ephemeral: true }));
      if (message.t === 'data') {
        sent.set(id, message.value);
        if (sent.size > 50) {
          const [oldest] = sent.keys();
          sent.delete(oldest);
        }
      }
      return true;
    };
    const sendData = async (value: unknown) => {
      if (!(await send({ t: 'data', from: this.#id, value }))) outbox.push(value);
    };
    this.#sendData = sendData;
    this.#sendCommand = (op: 'next' | 'prev' | 'go', index?: number) => {
      send({ t: 'cmd', from: this.#id, op, index });
    };

    const isPresenter = !!fragment.presenterKey;
    this.#state({ isPresenter });

    const join = async () => {
      if (isPresenter && fragment.presenterKey) {
        await send({ t: 'presenter_join', from: this.#id, key: fragment.presenterKey });
      } else {
        await send({ t: 'join', from: this.#id });
        const queued = outbox;
        outbox = [];
        for (const value of queued) await sendData(value);
      }
    };

    const handle = async (frame: RelayFrame) => {
      if (frame.type === 'ready') {
        delay = 1000;
        this.#state({ status: this.#state.view === null ? 'waiting' : 'live' });
        await join();
      } else if (frame.type === 'undeliverable') {
        // The presenter isn't connected: keep the answer for when it is.
        if (sent.has(frame.message_id)) outbox.push(sent.get(frame.message_id));
        sent.delete(frame.message_id);
      } else if (frame.type === 'ephemeral' || frame.type === 'message') {
        let message: PresenterMessage;
        try {
          message = await unseal(await keyPromise, frame.payload);
        } catch {
          return; // Not sealed with this room's key.
        }
        if (message.t === 'view') this.#showView(message.html);
        else if (message.t === 'data') this.#deliver(message.value);
        else if (message.t === 'hello') this.#state({ number: message.n });
        else if (message.t === 'notice') this.#popup(message.text);
        else if (message.t === 'present') await join();
        else if (message.t === 'presenter_init') {
          this.#state({
            presenterConnected: true,
            currentSlide: message.current,
            totalSlides: message.total,
            slides: message.slides,
          });
          this.#startTimer();
          this.#requestWakeLock();
          if (this.#bodyRef.value) this.#bodyRef.value.scrollTop = 0;
        } else if (message.t === 'presenter_sync') {
          this.#state({ presenterConnected: true, currentSlide: message.index });
          if (this.#bodyRef.value) this.#bodyRef.value.scrollTop = 0;
        }
      }
    };

    const connect = () => {
      clearTimeout(retry);
      const url = new URL(relayUrl());
      url.searchParams.set('id', `live_${fragment.room}`);
      url.searchParams.set('endpoint', '2');
      url.searchParams.set('device_id', this.#id);
      const current = new WebSocket(url);
      socket = current;
      // Decrypting is async; a chain keeps frames in order (a view before the data meant for it).
      let queue = Promise.resolve();
      current.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data) as RelayFrame;
        queue = queue.then(() => (socket === current ? handle(frame) : undefined));
      };
      current.onclose = () => {
        if (socket !== current || closed) return;
        this.#state({ status: this.#state.view === null ? 'connecting' : 'reconnecting' });
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
    };
    const reconnect = () => {
      const old = socket;
      delay = 1000;
      connect();
      old?.close();
    };
    connect();

    // Phones drop the socket while another app is in front, sometimes without telling the page: come back at once,
    // and after a long absence don't trust a socket that still looks open.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (!socket || socket.readyState > WebSocket.OPEN || Date.now() - hiddenAt > 15000) reconnect();
    };
    const onOnline = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) reconnect();
    };
    // Scanning another room's code in the same tab only changes the hash.
    const onHashChange = () => location.reload();
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('online', onOnline);
    addEventListener('hashchange', onHashChange);

    const onFrameMessage = (event: MessageEvent) => {
      if (event.source !== this.#frameRef.value?.contentWindow || event.data?.t !== 'data') return;
      this.#sendData?.(event.data.value);
    };
    addEventListener('message', onFrameMessage);

    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
      removeEventListener('message', onFrameMessage);
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('online', onOnline);
      removeEventListener('hashchange', onHashChange);
      clearInterval(this.#timerInterval);
      this.#wakeLockObj?.release().catch(() => {});
    };
  };

  #startTimer = () => {
    if (this.#timerInterval) return;
    this.#timerInterval = setInterval(() => {
      this.#state({ elapsedSec: this.#state.elapsedSec + 1 });
    }, 1000);
  };

  #resetTimer = () => {
    this.#state({ elapsedSec: 0 });
  };

  #formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  #requestWakeLock = async () => {
    if ('wakeLock' in navigator && !this.#wakeLockObj) {
      try {
        this.#wakeLockObj = await navigator.wakeLock.request('screen');
        this.#state({ wakeLocked: true });
        this.#wakeLockObj.addEventListener('release', () => {
          this.#wakeLockObj = null;
          this.#state({ wakeLocked: false });
        });
      } catch {
        this.#state({ wakeLocked: false });
      }
    }
  };

  #toggleWakeLock = async () => {
    if (this.#wakeLockObj) {
      await this.#wakeLockObj.release().catch(() => {});
      this.#wakeLockObj = null;
      this.#state({ wakeLocked: false });
    } else {
      await this.#requestWakeLock();
    }
  };

  #adjustFontSize = (delta: number) => {
    const nextSize = Math.max(14, Math.min(36, this.#state.fontSize + delta));
    this.#state({ fontSize: nextSize });
  };

  #formatNotes = (htmlStr: string) => {
    const parseCue = (_m: string, text: string) => {
      let cls = 'cue-default';
      if (/翻页|下一页|Next/i.test(text)) cls = 'cue-flip';
      else if (/停顿|暂停|等|Pause/i.test(text)) cls = 'cue-pause';
      else if (/扫码|互动|投票|提问|点赞|看屏幕|看大屏|大屏幕|Scan|Poll|Vote|Screen/i.test(text)) cls = 'cue-interact';
      return `<span class="cue ${cls}">${text}</span>`;
    };
    return htmlStr.replace(/【(.*?)】/g, parseCue).replace(/\[(.*?)\]/g, parseCue);
  };

  /** Replaces the frame only when the view changed, so a presenter reconnecting doesn't wipe half-typed answers. */
  #showView = (htmlStr: string) => {
    if (htmlStr === this.#state.view) return this.#state({ status: 'live' });
    this.#frameReady = false;
    this.#pending = [];
    this.#state({ status: 'live', view: htmlStr });
  };

  #popupTimer?: ReturnType<typeof setTimeout>;

  #popup = (text: string) => {
    clearTimeout(this.#popupTimer);
    this.#state({ popup: text });
    this.#popupTimer = setTimeout(() => this.#state({ popup: '' }), 4000);
  };

  #deliver = (value: unknown) => {
    const frame = this.#frameRef.value;
    if (this.#frameReady && frame?.contentWindow) frame.contentWindow.postMessage({ t: 'data', value }, '*');
    else this.#pending.push(value);
  };

  #onFrameLoad = () => {
    this.#frameReady = true;
    const pending = this.#pending;
    this.#pending = [];
    pending.forEach(this.#deliver);
  };

  @template()
  #content = () => {
    if (this.#state.isPresenter) {
      return this.#presenterView();
    }
    return html`
      <div class="bar" v-if=${!!this.#state.number || this.#state.status === 'reconnecting'}>
        <span>${this.#state.number ? i18n.get('audienceNumber').replace('%', String(this.#state.number)) : ''}</span>
        <span v-if=${this.#state.status === 'reconnecting'}>${i18n.get('audienceReconnecting')}</span>
      </div>
      ${this.#main()}
      <div class="popup" v-if=${!!this.#state.popup} @click=${() => this.#state({ popup: '' })}>
        <p>${this.#state.popup}</p>
      </div>
    `;
  };

  #presenterView = () => {
    const { presenterConnected, currentSlide, totalSlides, slides, fontSize, wakeLocked, elapsedSec } = this.#state;
    const currentNotes = slides[currentSlide]?.notes?.trim();

    return html`
      <div class="prompter-wrap">
        <div class="prompter-header">
          <span class="prompter-status-badge ${presenterConnected ? '' : 'disconnected'}">
            ${presenterConnected ? `🟢 ${i18n.get('presenterConnected')}` : `🔴 ${i18n.get('presenterConnecting')}`}
          </span>
          <div class="prompter-meta">
            <span class="prompter-page-text">${totalSlides > 0 ? `${currentSlide + 1} / ${totalSlides}` : '- / -'}</span>
            <span class="prompter-timer-text" @click=${this.#resetTimer}>${this.#formatTime(elapsedSec)}</span>
          </div>
          <div class="prompter-actions">
            <button class="prompter-btn" @click=${() => this.#adjustFontSize(-2)}>A-</button>
            <button class="prompter-btn" @click=${() => this.#adjustFontSize(2)}>A+</button>
            <button class="prompter-btn ${wakeLocked ? 'wake-on' : ''}" @click=${this.#toggleWakeLock}>
              ${i18n.get('presenterWakeLock')}
            </button>
          </div>
        </div>

        <div
          ${this.#bodyRef}
          class="prompter-body"
          style="font-size: ${fontSize}px;"
          .innerHTML=${currentNotes ? this.#formatNotes(currentNotes) : `<div class="prompter-empty">${i18n.get('presenterNoNotes')}</div>`}
        ></div>

        <div class="prompter-nav">
          <button
            class="prompter-nav-btn"
            ?disabled=${!presenterConnected || currentSlide <= 0}
            @click=${() => this.#sendCommand?.('prev')}
          >
            ${i18n.get('presenterPrev')}
          </button>
          <button
            class="prompter-nav-btn next"
            ?disabled=${!presenterConnected || (totalSlides > 0 && currentSlide >= totalSlides - 1)}
            @click=${() => this.#sendCommand?.('next')}
          >
            ${i18n.get('presenterNext')}
          </button>
        </div>
      </div>
    `;
  };

  #main = () => {
    const { status, view } = this.#state;
    if (view !== null) {
      return html`
        <iframe
          ${this.#frameRef}
          title=${i18n.get('audienceTitle')}
          sandbox="allow-scripts allow-forms"
          .srcdoc=${frameDocument(view, this.#id)}
          @load=${this.#onFrameLoad}
        ></iframe>
      `;
    }
    const message = {
      connecting: i18n.get('audienceConnecting'),
      waiting: i18n.get('audienceWaiting'),
      live: i18n.get('audienceWaiting'),
      reconnecting: i18n.get('audienceConnecting'),
      invalid: i18n.get('audienceInvalid'),
      unsupported: i18n.get('audienceUnsupported'),
    }[status];
    return html`
      <div class="notice">
        <img src="/icon.png" alt="" />
        <span class="dot" v-if=${status === 'connecting' || status === 'waiting'}></span>
        <p>${message}</p>
      </div>
    `;
  };
}
