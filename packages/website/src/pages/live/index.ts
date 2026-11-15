import { frameDocument } from './_frame';
import {
  type AudienceMessage,
  importKey,
  type PresenterMessage,
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
    background: #0e1133;
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
    background: var(--cyan);
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
    background: rgb(14 17 51 / 0.55);
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
`;

@page({
  title: () => i18n.get('audienceTitle'),
  meta: () => ({ robots: 'noindex' }),
})
@adoptedStyle(style)
export default class LivePage extends GemElement {
  #state = createState({ status: 'connecting' as Status, view: null as string | null, number: 0, popup: '' });
  #frameRef = createRef<HTMLIFrameElement>();
  #id = '';
  /** Presenter data waiting for the current view's frame to load. */
  #pending: unknown[] = [];
  #frameReady = false;
  #sendData?: (value: unknown) => void;

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
    const join = async () => {
      await send({ t: 'join', from: this.#id });
      const queued = outbox;
      outbox = [];
      for (const value of queued) await sendData(value);
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
    };
  };

  /** Replaces the frame only when the view changed, so a presenter reconnecting doesn't wipe half-typed answers. */
  #showView = (html: string) => {
    if (html === this.#state.view) return this.#state({ status: 'live' });
    this.#frameReady = false;
    this.#pending = [];
    this.#state({ status: 'live', view: html });
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
  #content = () => html`
    <div class="bar" v-if=${!!this.#state.number || this.#state.status === 'reconnecting'}>
      <span>${this.#state.number ? i18n.get('audienceNumber').replace('%', String(this.#state.number)) : ''}</span>
      <span v-if=${this.#state.status === 'reconnecting'}>${i18n.get('audienceReconnecting')}</span>
    </div>
    ${this.#main()}
    <div class="popup" v-if=${!!this.#state.popup} @click=${() => this.#state({ popup: '' })}>
      <p>${this.#state.popup}</p>
    </div>
  `;

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
