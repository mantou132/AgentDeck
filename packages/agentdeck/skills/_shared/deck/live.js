/*
 * Scan-to-answer for a deck (courseware or presentation): the audience scans a QR code, opens the AgentDeck
 * audience page (https://agentdeck.xianqiao.wang/zh/live) on their phones and answers; this page shows the results
 * live. Load after deck.js. Needs this computer and the phones online. Elements:
 *   <cw-live-join>                       QR code and how many joined
 *   <cw-poll options="…" correct="2">    single or multiple choice, also true/false
 *   <cw-responses type="number|text">    collect a number or a short text from everyone
 *   <cw-wordcloud max="3">               a word cloud of short words
 *   <cw-rating max="5">                  stars (or 1–max) with the average and distribution
 *   <cw-questions>                       questions with upvotes, asked from any slide, shown on its own slide
 *   <cw-reactions emoji="👏,❤️">          emoji the audience taps on any slide, floating up over the deck
 * Each phone gets a number (1 号, 2 号 …) that stays the same for this deck, and the toolbar's picker draws among
 * them. `CwLive.room()` gives the room for custom interactives. Protocol and internals: README.md.
 */
(() => {
  const SITE = 'https://agentdeck.xianqiao.wang';
  const RELAY_URL = 'wss://agentdeck.xianqiao.wang/ws';
  const QR_MODULE = 'https://esm.sh/qrcode-generator@2.0.4';

  const b64url = (bytes) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const unb64url = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const random = (length) => b64url(crypto.getRandomValues(new Uint8Array(length)));

  const importKey = (raw) => crypto.subtle.importKey('raw', unb64url(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

  const seal = async (key, message) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(message));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
    return { iv: b64url(iv), c: b64url(sealed) };
  };

  const unseal = async (key, payload) => {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(payload.iv) }, key, unb64url(payload.c));
    return JSON.parse(new TextDecoder().decode(data));
  };

  /**
   * Parts every phone shows under whatever view is on (the reaction bar, the 提问 button), registered by elements
   * when the deck loads. Each is HTML whose scripts add buttons to `#dock`.
   */
  const docks = [];

  const DOCK_BASE = `
<style>
body { padding-bottom: calc(110px + env(safe-area-inset-bottom)); }
#dock { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; display: flex; gap: 6px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: rgb(255 255 255 / 0.96); border-top: 1px solid var(--line); }
#dock button { width: auto; margin: 0; padding: 10px 16px; border-radius: 999px; text-align: center; }
#dock .emoji { padding: 6px 8px; border: 0; background: transparent; font-size: 28px; line-height: 1; }
#dock .emoji:active { transform: scale(1.3); }
</style>
<div id="dock"></div>`;

  const WAITING = '<p class="muted center" style="margin-top:30vh">已加入，请看大屏幕</p>';

  const load = (storageKey) => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}');
    } catch (_error) {
      return {}; // Storage may be unavailable for file:// pages; the room then lasts until the page closes.
    }
  };

  const save = (storageKey, value) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (_error) {
      // See above.
    }
  };

  // Plain fields and methods (no `#private`, `?.` or `??`): this runs on classroom computers with old browsers.
  class LiveRoom extends EventTarget {
    constructor(storageKey, saved, key) {
      super();
      this.status = 'connecting';
      this._storageKey = storageKey;
      this._saved = saved;
      this._key = key;
      this._device = `presenter-${random(9)}`;
      this._view = null;
      this._socket = null;
      this._delay = 1000;
      this._connect();
    }

    /** The link the audience opens. */
    get url() {
      return `${SITE}/zh/live#${this._saved.room}.${this._saved.key}`;
    }

    /** How many phones have joined this deck. */
    get count() {
      return Object.keys(this._saved.numbers).length;
    }

    /** A phone's number, given out the first time it joins and kept for this deck. */
    numberOf(from) {
      return this._saved.numbers[from];
    }

    /** Listens to `join` ({ from }), `data` ({ from, value }) or `status` (string); returns a function that stops. */
    on(type, listener) {
      const handler = (event) => listener(event.detail);
      this.addEventListener(type, handler);
      return () => this.removeEventListener(type, handler);
    }

    /** Shows `html` on every phone, including ones that join later. Scripts in it run in a sandbox with `live`. */
    show(html) {
      this._view = html;
      this._send({ t: 'view', html: this._composed() });
    }

    /** Sends `value` to the phones' `live.onmessage`, to everyone or to one id. */
    send(value, to) {
      this._send({ t: 'data', value }, to);
    }

    /** Pops up `text` on one phone over whatever it shows, if it's connected. */
    notice(text, to) {
      this._send({ t: 'notice', text }, to);
    }

    /** An SVG QR code of `url`, `size` pixels wide. */
    async qr(size) {
      const qrcode = (await import(QR_MODULE)).default;
      const code = qrcode(0, 'M');
      code.addData(this.url);
      code.make();
      const count = code.getModuleCount();
      const margin = 2;
      let path = '';
      for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
          if (code.isDark(y, x)) path += `M${x + margin} ${y + margin}h1v1h-1z`;
        }
      }
      const total = count + margin * 2;
      const svg = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`,
        'image/svg+xml',
      ).documentElement;
      return document.importNode(svg, true);
    }

    /** The current view with the dock under it; before any view, a waiting line with the dock. */
    _composed() {
      if (!docks.length) return this._view;
      return (this._view === null ? WAITING : this._view) + DOCK_BASE + docks.join('');
    }

    _emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    _setStatus(status) {
      if (this.status === status) return;
      this.status = status;
      this._emit('status', status);
    }

    _number(from) {
      const numbers = this._saved.numbers;
      if (!numbers[from]) {
        numbers[from] = this.count + 1;
        save(this._storageKey, this._saved);
      }
      return numbers[from];
    }

    _connect() {
      const url = new URL(RELAY_URL);
      url.searchParams.set('id', `live_${this._saved.room}`);
      url.searchParams.set('endpoint', '1');
      url.searchParams.set('device_id', this._device);
      const socket = new WebSocket(url);
      this._socket = socket;
      // Decrypting is async; the chain handles frames in order (a changed answer after the first one).
      let queue = Promise.resolve();
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data);
        queue = queue.then(() => (this._socket === socket ? this._handle(frame) : undefined));
      };
      socket.onclose = () => {
        if (this._socket !== socket) return;
        this._setStatus('reconnecting');
        setTimeout(() => this._connect(), this._delay);
        this._delay = Math.min(this._delay * 2, 30000);
      };
    }

    async _handle(frame) {
      if (frame.type === 'ready') {
        this._delay = 1000;
        this._setStatus('connected');
        // Phones that came before this page (or stayed while it reloaded) join again and get their number and view.
        this._send({ t: 'present' });
      } else if (frame.type === 'ephemeral' || frame.type === 'message') {
        let message;
        try {
          message = await unseal(this._key, frame.payload);
        } catch (_error) {
          return; // Not sealed with this room's key.
        }
        if (typeof message.from !== 'string') return;
        if (message.t === 'join') {
          this._send({ t: 'hello', n: this._number(message.from) }, message.from);
          if (this._view !== null || docks.length) this._send({ t: 'view', html: this._composed() }, message.from);
          this._emit('join', { from: message.from });
        } else if (message.t === 'data') {
          this._number(message.from);
          this._emit('data', { from: message.from, value: message.value });
        }
      }
    }

    /** Sealing is async; the chain keeps messages in order (a view before the data meant for it). */
    _send(message, to) {
      this._sending = (this._sending || Promise.resolve()).then(() => this._sendNow(message, to));
      return this._sending;
    }

    async _sendNow(message, to) {
      const payload = await seal(this._key, message);
      const socket = this._socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || this.status !== 'connected') return;
      const frame = { type: 'message', message_id: random(12), payload, ephemeral: true };
      if (to) frame.target_device_id = to;
      socket.send(JSON.stringify(frame));
    }
  }

  let roomPromise = null;

  /** One room per deck, kept across reloads so a QR code on screen keeps working and numbers stay the same. */
  function room() {
    if (!roomPromise) {
      const storageKey = `cw-live:${location.pathname}`;
      const saved = load(storageKey);
      if (!saved.room) saved.room = random(16);
      if (!saved.key) saved.key = random(32);
      if (!saved.numbers) saved.numbers = {};
      save(storageKey, saved);
      roomPromise = importKey(saved.key).then((key) => {
        const r = new LiveRoom(storageKey, saved, key);
        if (window.courseware) {
          window.courseware.setPickerSource({
            names: () =>
              Object.keys(saved.numbers)
                .map((id) => saved.numbers[id])
                .sort((a, b) => a - b)
                .map((n) => `${n} 号`),
            picked: (name) => {
              const n = parseInt(name, 10);
              const id = Object.keys(saved.numbers).filter((key) => saved.numbers[key] === n)[0];
              if (id) r.notice('你被抽到了！', id);
            },
          });
        }
        return r;
      });
    }
    return roomPromise;
  }

  window.CwLive = { room };

  function esc(text) {
    return String(text).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  function list(value) {
    return (value || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function offline(el) {
    el.innerHTML = '<p class="muted small">扫码互动需要联网，请检查这台电脑的网络。</p>';
  }

  /** Data inlined into a view's script; `<` is escaped so the HTML can't be closed early. */
  function json(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  /** The question students see: the attribute, else the slide's heading. */
  function questionOf(el) {
    if (el.getAttribute('question')) return el.getAttribute('question');
    const heading = (el.closest('.slide') || el).querySelector('h2');
    if (!heading) return '';
    const copy = heading.cloneNode(true);
    for (const tag of copy.querySelectorAll('.tag')) tag.remove();
    return copy.textContent.trim();
  }

  /** Runs `fn` each time the element's slide is shown, and now if it is showing. */
  function onSlideEnter(el, fn) {
    const slide = el.closest('.slide');
    if (!slide) return;
    slide.addEventListener('cw-enter', (event) => {
      if (event.target === slide) fn();
    });
    if (slide.classList.contains('cw-current')) fn();
  }

  function button(parent, text, onClick, cls) {
    const b = document.createElement('button');
    b.className = `cw-btn${cls ? ` ${cls}` : ''}`;
    b.textContent = text;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    parent.appendChild(b);
  }

  async function addQr(el, size) {
    try {
      const r = await room();
      const box = document.createElement('div');
      box.className = 'cw-live-qr';
      box.appendChild(await r.qr(size));
      el.prepend(box);
    } catch (_error) {
      // Offline: the element already says so.
    }
  }

  class LiveJoin extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('cw-live');
      const size = Number(this.getAttribute('size')) || 420;
      this.innerHTML = '<div class="cw-live-qr"></div><div class="cw-live-info"></div>';
      room().then(
        async (r) => {
          const info = this.querySelector('.cw-live-info');
          const render = () => {
            const state = { connecting: '连接中…', connected: '', reconnecting: '网络断开，正在重连…' }[r.status];
            info.innerHTML = `<p class="big">扫码加入</p><p class="huge primary-text">${r.count} <span class="small muted">人已加入</span></p><p class="small muted">${state || '用手机扫码，不需要安装应用'}</p>`;
          };
          r.on('join', render);
          r.on('data', render);
          r.on('status', render);
          render();
          try {
            this.querySelector('.cw-live-qr').appendChild(await r.qr(size));
          } catch (_error) {
            offline(info);
          }
        },
        () => offline(this),
      );
    }
  }

  const POLL_VIEW = `
<h2 id="q"></h2><div id="opts"></div><button class="primary" id="submit" hidden>提交</button><p class="muted center" id="note"></p>
<script>
(() => {
  const cfg = __CFG__;
  let picked = [];
  let locked = false;
  const note = document.getElementById('note');
  const submit = document.getElementById('submit');
  document.getElementById('q').textContent = cfg.question;
  const buttons = cfg.options.map((text, i) => {
    const b = document.createElement('button');
    b.textContent = String.fromCharCode(65 + i) + '. ' + text;
    b.onclick = () => {
      if (locked) return;
      if (cfg.multiple) picked = picked.includes(i) ? picked.filter((p) => p !== i) : picked.concat(i);
      else { picked = [i]; send(); }
      paint();
    };
    document.getElementById('opts').appendChild(b);
    return b;
  });
  const paint = () => buttons.forEach((b, i) => b.classList.toggle('selected', picked.includes(i)));
  const send = () => {
    live.send({ id: cfg.id, choice: picked.slice().sort((a, b) => a - b) });
    note.textContent = cfg.multiple ? '已提交，可以修改后再提交' : '已提交，可以改选';
  };
  if (cfg.multiple) { submit.hidden = false; submit.onclick = () => { if (!locked && picked.length) send(); }; }
  live.onmessage = (m) => {
    if (!m || m.id !== cfg.id) return;
    if (m.reveal) {
      locked = true;
      submit.disabled = true;
      buttons.forEach((b, i) => {
        b.disabled = true;
        if (m.reveal.includes(i)) b.classList.add('right');
        else if (picked.includes(i)) b.classList.add('wrong');
      });
      const right = picked.length && picked.join() === m.reveal.join();
      note.textContent = picked.length ? (right ? '答对了！' : '再想想正确答案为什么是它') : '';
    }
    if (m.reset) {
      locked = false;
      picked = [];
      submit.disabled = false;
      buttons.forEach((b) => { b.disabled = false; b.className = ''; });
      note.textContent = '';
    }
  };
})();
${'</'}script>`;

  class Poll extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('cw-live');
      this._id = uid();
      this._answers = new Map();
      this._revealed = false;
      this.innerHTML =
        '<div class="cw-live-body"><div class="cw-live-bars"></div><p class="cw-live-total small muted"></p><div class="cw-controls"></div></div>';
      const controls = this.querySelector('.cw-controls');
      if (this.getAttribute('correct')) button(controls, '公布答案', () => this._reveal(), 'primary');
      button(controls, '重新作答', () => this.cwReset());
      this._render();
      room().then(
        (r) => {
          r.on('data', ({ from, value }) => {
            if (!value || value.id !== this._id || !Array.isArray(value.choice)) return;
            this._answers.set(from, value.choice);
            this._render();
          });
          onSlideEnter(this, () => r.show(this._view()));
          if (this.hasAttribute('qr')) addQr(this, 260);
        },
        () => offline(this.querySelector('.cw-live-total')),
      );
    }

    get _options() {
      return list(this.getAttribute('options'));
    }

    get _correct() {
      return list(this.getAttribute('correct')).map((n) => Number(n) - 1);
    }

    _view() {
      const cfg = {
        id: this._id,
        question: questionOf(this),
        options: this._options,
        multiple: this.hasAttribute('multiple'),
      };
      return POLL_VIEW.replace('__CFG__', json(cfg));
    }

    _reveal() {
      this._revealed = true;
      this._render();
      room().then(
        (r) => r.send({ id: this._id, reveal: this._correct }),
        () => {},
      );
    }

    cwReset() {
      this._answers.clear();
      this._revealed = false;
      this._render();
      room().then(
        (r) => r.send({ id: this._id, reset: true }),
        () => {},
      );
    }

    _render() {
      const options = this._options;
      const counts = options.map(() => 0);
      for (const choice of this._answers.values()) for (const i of choice) if (counts[i] !== undefined) counts[i]++;
      const total = this._answers.size;
      const correct = this._correct;
      const max = Math.max(1, ...counts);
      this.querySelector('.cw-live-bars').innerHTML = options
        .map((text, i) => {
          const right = this._revealed && correct.includes(i);
          const pct = total ? Math.round((counts[i] / total) * 100) : 0;
          return `<div class="cw-live-bar${right ? ' cw-right' : ''}"><span class="cw-live-label">${String.fromCharCode(65 + i)}. ${esc(text)}</span><span class="cw-live-track"><span style="width:${(counts[i] / max) * 100}%"></span></span><span class="cw-live-count">${counts[i]}<small>${total ? ` ${pct}%` : ''}</small></span></div>`;
        })
        .join('');
      let summary = `已作答 ${total} 人`;
      if (this._revealed && total) {
        let right = 0;
        for (const choice of this._answers.values()) if (choice.join() === correct.join()) right++;
        summary += `，答对 ${right} 人（${Math.round((right / total) * 100)}%）`;
      }
      this.querySelector('.cw-live-total').textContent = summary;
    }
  }

  const RESPONSE_VIEW = `
<h2 id="q"></h2><input id="v" autocomplete="off"><button class="primary" id="go">提交</button><p class="muted center" id="note"></p>
<script>
(() => {
  const cfg = __CFG__;
  const input = document.getElementById('v');
  const note = document.getElementById('note');
  document.getElementById('q').textContent = cfg.question;
  if (cfg.type === 'number') { input.type = 'text'; input.inputMode = 'decimal'; }
  else { input.maxLength = 40; }
  input.placeholder = cfg.placeholder || (cfg.type === 'number' ? '填一个数' : '写一句话');
  const go = () => {
    const raw = input.value.trim();
    if (!raw) return;
    if (cfg.type === 'number' && !/^-?\\d+(\\.\\d+)?$/.test(raw)) { note.textContent = '请填一个数'; return; }
    live.send({ id: cfg.id, value: raw });
    note.textContent = '已提交，可以修改后再提交';
  };
  document.getElementById('go').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  live.onmessage = (m) => {
    if (!m || m.id !== cfg.id) return;
    if (m.reveal !== undefined) note.textContent = '答案：' + m.reveal;
    if (m.reset) { input.value = ''; note.textContent = ''; }
  };
})();
${'</'}script>`;

  class Responses extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('cw-live');
      this._id = uid();
      this._answers = new Map();
      this._hidden = new Set();
      this._revealed = false;
      this.innerHTML =
        '<div class="cw-live-body"><div class="cw-live-stats"></div><div class="cw-live-wall"></div><div class="cw-controls"></div></div>';
      const controls = this.querySelector('.cw-controls');
      if (this.getAttribute('answer')) button(controls, '公布答案', () => this._reveal(), 'primary');
      button(controls, '重新作答', () => this.cwReset());
      this.querySelector('.cw-live-wall').addEventListener('click', (e) => {
        const card = e.target.closest('[data-from]');
        if (!card) return;
        e.stopPropagation();
        this._hidden.add(card.getAttribute('data-from'));
        this._render();
      });
      this._render();
      room().then(
        (r) => {
          r.on('data', ({ from, value }) => {
            if (!value || value.id !== this._id || typeof value.value !== 'string') return;
            this._answers.delete(from);
            this._answers.set(from, value.value.slice(0, 40));
            this._hidden.delete(from);
            this._render();
          });
          onSlideEnter(this, () => r.show(this._view()));
          if (this.hasAttribute('qr')) addQr(this, 260);
        },
        () => offline(this.querySelector('.cw-live-stats')),
      );
    }

    get _type() {
      return this.getAttribute('type') === 'number' ? 'number' : 'text';
    }

    _view() {
      const cfg = {
        id: this._id,
        question: questionOf(this),
        type: this._type,
        placeholder: this.getAttribute('placeholder') || '',
      };
      return RESPONSE_VIEW.replace('__CFG__', json(cfg));
    }

    _reveal() {
      this._revealed = true;
      this._render();
      room().then(
        (r) => r.send({ id: this._id, reveal: this.getAttribute('answer') }),
        () => {},
      );
    }

    cwReset() {
      this._answers.clear();
      this._hidden.clear();
      this._revealed = false;
      this._render();
      room().then(
        (r) => r.send({ id: this._id, reset: true }),
        () => {},
      );
    }

    _render() {
      const unit = esc(this.getAttribute('unit') || '');
      const answer = this.getAttribute('answer');
      const entries = [...this._answers].filter(([from]) => !this._hidden.has(from));
      const stats = this.querySelector('.cw-live-stats');
      const wall = this.querySelector('.cw-live-wall');
      if (this._type === 'number') {
        const counts = new Map();
        for (const [, v] of entries) counts.set(Number(v), (counts.get(Number(v)) || 0) + 1);
        const values = entries.map(([, v]) => Number(v));
        const sorted = [...counts].sort((a, b) => a[0] - b[0]);
        const right = answer === null ? 0 : values.filter((v) => v === Number(answer)).length;
        stats.innerHTML = values.length
          ? `已作答 ${values.length} 人　最小 ${Math.min(...values)}${unit}　最大 ${Math.max(...values)}${unit}　平均 ${Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100}${unit}${this._revealed ? `　答对 ${right} 人` : ''}`
          : '已作答 0 人';
        wall.innerHTML = sorted
          .map(
            ([v, n]) =>
              `<span class="cw-live-chip${this._revealed && v === Number(answer) ? ' cw-right' : ''}">${v}${unit}${n > 1 ? `<small> ×${n}</small>` : ''}</span>`,
          )
          .join('');
      } else {
        stats.textContent = `已作答 ${entries.length} 人${entries.length ? '（点卡片可隐藏）' : ''}`;
        wall.innerHTML = entries
          .reverse()
          .map(([from, v]) => `<span class="cw-live-card" data-from="${esc(from)}">${esc(v)}</span>`)
          .join('');
      }
    }
  }

  /** Broadcasts at most every 300 ms, so a burst of answers sends one update. */
  function throttled(fn) {
    let timer = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, 300);
    };
  }

  function isCurrent(el) {
    const slide = el.closest('.slide');
    return !!slide && slide.classList.contains('cw-current');
  }

  const WORDCLOUD_VIEW = `
<h2 id="q"></h2><input id="v" autocomplete="off" maxlength="16"><button class="primary" id="go">提交</button><p class="muted center" id="note"></p><div id="mine"></div>
<style>#mine { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; } #mine span { padding: 6px 14px; border-radius: 999px; background: #eef0fb; }</style>
<script>
(() => {
  const cfg = __CFG__;
  const input = document.getElementById('v');
  const note = document.getElementById('note');
  const mine = document.getElementById('mine');
  let words = [];
  document.getElementById('q').textContent = cfg.question;
  input.placeholder = cfg.placeholder || '写一个词';
  const paint = () => {
    mine.textContent = '';
    words.forEach((w) => { const s = document.createElement('span'); s.textContent = w; mine.appendChild(s); });
    note.textContent = !words.length ? '' : words.length < cfg.max ? '已提交，还可以再写 ' + (cfg.max - words.length) + ' 个' : '已提交，再写会替换最早的一个';
  };
  const go = () => {
    const w = input.value.trim().replace(/\\s+/g, ' ');
    if (!w) return;
    words = words.filter((x) => x !== w).concat(w).slice(-cfg.max);
    live.send({ id: cfg.id, words });
    input.value = '';
    paint();
  };
  document.getElementById('go').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  live.onmessage = (m) => { if (m && m.id === cfg.id && m.reset) { words = []; paint(); } };
})();
${'</'}script>`;

  class WordCloud extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('cw-live');
      this._id = uid();
      this._answers = new Map();
      this._hidden = new Set();
      this.innerHTML =
        '<div class="cw-live-body"><div class="cw-cloud"></div><p class="cw-live-total small muted"></p><div class="cw-controls"></div></div>';
      button(this.querySelector('.cw-controls'), '重新收集', () => this.cwReset());
      this.querySelector('.cw-cloud').addEventListener('click', (e) => {
        const word = e.target.closest('[data-key]');
        if (!word) return;
        e.stopPropagation();
        this._hidden.add(word.getAttribute('data-key'));
        this._render();
      });
      this._render();
      room().then(
        (r) => {
          r.on('data', ({ from, value }) => {
            if (!value || value.id !== this._id || !Array.isArray(value.words)) return;
            this._answers.set(
              from,
              value.words.filter((w) => typeof w === 'string').map((w) => w.trim().slice(0, 16)),
            );
            this._render();
          });
          onSlideEnter(this, () => {
            r.show(this._view());
            this._render();
          });
          if (this.hasAttribute('qr')) addQr(this, 260);
        },
        () => offline(this.querySelector('.cw-live-total')),
      );
    }

    get _max() {
      return Math.max(1, Number(this.getAttribute('max')) || 3);
    }

    _view() {
      const cfg = {
        id: this._id,
        question: questionOf(this),
        max: this._max,
        placeholder: this.getAttribute('placeholder') || '',
      };
      return WORDCLOUD_VIEW.replace('__CFG__', json(cfg));
    }

    cwReset() {
      this._answers.clear();
      this._hidden.clear();
      this._render();
      room().then(
        (r) => r.send({ id: this._id, reset: true }),
        () => {},
      );
    }

    /** Words by count; the same word in other letter case or spacing counts as one, shown as first written. */
    _words() {
      const counts = new Map();
      for (const words of this._answers.values()) {
        for (const w of words.slice(-this._max)) {
          const key = w.toLowerCase().replace(/\s+/g, ' ');
          if (!key || this._hidden.has(key)) continue;
          const entry = counts.get(key) || { key, text: w, n: 0 };
          entry.n++;
          counts.set(key, entry);
        }
      }
      return [...counts.values()].sort((a, b) => b.n - a.n);
    }

    _render() {
      const words = this._words();
      let total = 0;
      for (const w of words) total += w.n;
      this.querySelector('.cw-live-total').textContent =
        `已参与 ${this._answers.size} 人，${total} 个词${words.length ? '（点词可隐藏）' : ''}`;
      // Placing needs layout, so a hidden slide waits until it is shown.
      if (isCurrent(this)) this._layout(words);
    }

    /** Biggest words first, each on an outward spiral from the centre until it overlaps nothing. */
    _layout(words) {
      const cloud = this.querySelector('.cw-cloud');
      cloud.innerHTML = '';
      const width = cloud.clientWidth;
      const height = cloud.clientHeight;
      if (!words.length || !width || !height) return;
      const top = words[0].n;
      const placed = [];
      words.slice(0, 80).forEach((w, i) => {
        const span = document.createElement('span');
        span.textContent = w.text;
        span.setAttribute('data-key', w.key);
        span.style.fontSize = `${Math.round(40 + 110 * Math.sqrt(top > 1 ? (w.n - 1) / (top - 1) : 1))}px`;
        span.style.color = `var(--c${(i % 6) + 1})`;
        cloud.appendChild(span);
        const w2 = span.offsetWidth;
        const h2 = span.offsetHeight;
        for (let t = 0; t < 2000; t++) {
          const angle = t * 0.35;
          const radius = t * 1.6;
          const x = width / 2 + radius * Math.cos(angle) * 1.6 - w2 / 2;
          const y = height / 2 + radius * Math.sin(angle) - h2 / 2;
          if (x < 0 || y < 0 || x + w2 > width || y + h2 > height) continue;
          const box = { x, y, w: w2, h: h2 };
          const hit = placed.some((p) => x < p.x + p.w && p.x < x + w2 && y < p.y + p.h && p.y < y + h2);
          if (hit) continue;
          placed.push(box);
          span.style.left = `${x}px`;
          span.style.top = `${y}px`;
          return;
        }
        span.remove(); // No room left: the smallest words are dropped.
      });
    }
  }

  const RATING_VIEW = `
<h2 id="q"></h2><div id="opts"></div><p class="muted center" id="note"></p>
<style>
#opts { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 12px; }
#opts button { width: auto; margin: 0; min-width: 56px; text-align: center; }
#opts.stars button { border: 0; background: transparent; padding: 4px; font-size: 52px; line-height: 1; color: #d6d8e0; }
#opts.stars button.selected { color: #f2b01e; background: transparent; }
</style>
<script>
(() => {
  const cfg = __CFG__;
  const opts = document.getElementById('opts');
  const note = document.getElementById('note');
  let score = 0;
  document.getElementById('q').textContent = cfg.question;
  const stars = cfg.max <= 5;
  opts.className = stars ? 'stars' : '';
  const buttons = [];
  for (let i = 1; i <= cfg.max; i++) {
    const b = document.createElement('button');
    b.textContent = stars ? '★' : String(i);
    b.onclick = () => { score = i; live.send({ id: cfg.id, score: i }); paint(); };
    opts.appendChild(b);
    buttons.push(b);
  }
  const paint = () => {
    buttons.forEach((b, i) => b.classList.toggle('selected', stars ? i < score : i + 1 === score));
    note.textContent = score ? '已评 ' + score + ' 分，可以修改' : '';
  };
  live.onmessage = (m) => { if (m && m.id === cfg.id && m.reset) { score = 0; paint(); } };
})();
${'</'}script>`;

  class Rating extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('cw-live');
      this._id = uid();
      this._answers = new Map();
      this.innerHTML =
        '<div class="cw-rating-score"></div><div class="cw-live-body"><div class="cw-live-bars"></div><div class="cw-controls"></div></div>';
      button(this.querySelector('.cw-controls'), '重新评分', () => this.cwReset());
      this._render();
      room().then(
        (r) => {
          r.on('data', ({ from, value }) => {
            if (!value || value.id !== this._id) return;
            const score = Number(value.score);
            if (!(score >= 1 && score <= this._max && score === Math.round(score))) return;
            this._answers.set(from, score);
            this._render();
          });
          onSlideEnter(this, () => r.show(this._view()));
          if (this.hasAttribute('qr')) addQr(this, 260);
        },
        () => offline(this.querySelector('.cw-live-bars')),
      );
    }

    get _max() {
      return Math.min(10, Math.max(2, Number(this.getAttribute('max')) || 5));
    }

    _view() {
      return RATING_VIEW.replace('__CFG__', json({ id: this._id, question: questionOf(this), max: this._max }));
    }

    cwReset() {
      this._answers.clear();
      this._render();
      room().then(
        (r) => r.send({ id: this._id, reset: true }),
        () => {},
      );
    }

    _render() {
      const max = this._max;
      const counts = [];
      for (let i = 0; i <= max; i++) counts.push(0);
      let sum = 0;
      for (const score of this._answers.values()) {
        counts[score]++;
        sum += score;
      }
      const total = this._answers.size;
      const top = Math.max(1, ...counts);
      const star = max <= 5 ? '★' : '';
      this.querySelector('.cw-rating-score').innerHTML =
        `<p class="huge">${total ? (sum / total).toFixed(1) : '–'}<span class="cw-rating-star">${star}</span></p><p class="small muted">${total} 人评分，满分 ${max}</p>`;
      let bars = '';
      for (let i = max; i >= 1; i--) {
        const pct = total ? Math.round((counts[i] / total) * 100) : 0;
        bars += `<div class="cw-live-bar"><span class="cw-live-label cw-rating-label">${star ? star.repeat(i) : `${i} 分`}</span><span class="cw-live-track"><span style="width:${(counts[i] / top) * 100}%"></span></span><span class="cw-live-count">${counts[i]}<small>${total ? ` ${pct}%` : ''}</small></span></div>`;
      }
      this.querySelector('.cw-live-bars').innerHTML = bars;
    }
  }

  const REACTIONS_DOCK = `
<script>
(() => {
  const cfg = __CFG__;
  const dock = document.getElementById('dock');
  let last = 0;
  cfg.emoji.forEach((e, i) => {
    const b = document.createElement('button');
    b.className = 'emoji';
    b.textContent = e;
    b.onclick = () => {
      const now = Date.now();
      if (now - last < 250) return;
      last = now;
      live.send({ id: cfg.id, e: i });
    };
    dock.appendChild(b);
  });
})();
${'</'}script>`;

  /** Registers the reaction bar on every phone and floats each tap up over the right side of the stage. */
  class Reactions extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      const id = uid();
      const emoji = list(this.getAttribute('emoji'));
      if (!emoji.length) emoji.push('👏', '❤️', '😂', '😮', '🤔');
      docks.push(REACTIONS_DOCK.replace('__CFG__', json({ id, emoji })));
      const layer = document.createElement('div');
      layer.id = 'cw-reactions';
      document.getElementById('cw-stage').appendChild(layer);
      room().then(
        (r) =>
          r.on('data', ({ value }) => {
            if (!value || value.id !== id || !emoji[value.e] || layer.childElementCount >= 40) return;
            const span = document.createElement('span');
            span.textContent = emoji[value.e];
            span.style.left = `${1500 + Math.random() * 300}px`;
            span.style.setProperty('--cw-drift', `${Math.round(Math.random() * 160 - 80)}px`);
            span.addEventListener('animationend', () => span.remove());
            layer.appendChild(span);
          }),
        () => {},
      );
    }
  }

  const QUESTIONS_DOCK = `
<style>
#q-sheet { position: fixed; inset: 0; z-index: 20; overflow: auto; padding: 20px 20px calc(24px + env(safe-area-inset-bottom)); background: #f6f7fb; }
#q-sheet header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
#q-sheet header h2 { margin: 0; }
#q-sheet header button { width: auto; margin: 0; padding: 8px 16px; }
#q-sheet textarea { min-height: 88px; }
#q-list button { display: flex; gap: 12px; align-items: flex-start; }
#q-list button span:first-child { flex: 1; }
#q-list button span:last-child { white-space: nowrap; color: var(--muted); }
#q-list button.selected span:last-child { color: var(--accent); font-weight: 700; }
#q-list button.done { opacity: 0.6; }
</style>
<div id="q-sheet" hidden>
  <header><h2>提问</h2><button id="q-close">关闭</button></header>
  <textarea id="q-text" maxlength="120" placeholder="写下你想问的问题"></textarea>
  <button class="primary" id="q-send">提交问题</button>
  <p class="muted center" id="q-note"></p>
  <div id="q-list"></div>
</div>
<script>
(() => {
  const cfg = __CFG__;
  const sheet = document.getElementById('q-sheet');
  const list = document.getElementById('q-list');
  const text = document.getElementById('q-text');
  const note = document.getElementById('q-note');
  const open = document.createElement('button');
  let qs = [];
  let mine = new Set();
  let sent = 0;
  open.onclick = () => { sheet.hidden = false; };
  document.getElementById('dock').appendChild(open);
  document.getElementById('q-close').onclick = () => { sheet.hidden = true; };
  if (window.liveOpenQuestions) sheet.hidden = false;
  document.getElementById('q-send').onclick = () => {
    const value = text.value.trim();
    if (!value) return;
    sent++;
    live.send({ id: cfg.id, ask: value, k: live.id + '-' + Date.now().toString(36) });
    text.value = '';
    note.textContent = '已提交，讲者会在提问环节看到';
  };
  const paint = () => {
    open.textContent = qs.length ? '提问 · ' + qs.length : '提问';
    list.textContent = '';
    if (qs.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '给想听的问题点赞';
      list.appendChild(p);
    }
    qs.forEach((q) => {
      const b = document.createElement('button');
      const t = document.createElement('span');
      const n = document.createElement('span');
      t.textContent = q.text;
      n.textContent = (q.now ? '正在回答 · ' : q.done ? '已回答 · ' : '') + '👍 ' + q.n;
      b.append(t, n);
      b.classList.toggle('selected', mine.has(q.k));
      b.classList.toggle('done', !!q.done && !q.now);
      b.onclick = () => {
        const on = !mine.has(q.k);
        if (on) mine.add(q.k); else mine.delete(q.k);
        q.n += on ? 1 : -1;
        live.send({ id: cfg.id, vote: q.k, on });
        paint();
      };
      list.appendChild(b);
    });
  };
  addEventListener('live', (e) => {
    const m = e.detail;
    if (!m || m.id !== cfg.id || !m.qs) return;
    qs = m.qs;
    if (m.mine) mine = new Set(m.mine);
    paint();
  });
  paint();
  live.send({ id: cfg.id, sync: true });
})();
${'</'}script>`;

  /**
   * Questions the audience asks from the 提问 button on any slide and upvotes; this element shows them on its slide
   * (the Q&A), where tapping one marks it as being answered.
   */
  class Questions extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('cw-live');
      this._id = uid();
      this._qs = [];
      this._now = null;
      this._broadcast = throttled(() =>
        room().then(
          (r) => r.send({ id: this._id, qs: this._public() }),
          () => {},
        ),
      );
      docks.push(QUESTIONS_DOCK.replace('__CFG__', json({ id: this._id })));
      this.innerHTML =
        '<div class="cw-live-body"><div class="cw-q-now"></div><p class="cw-live-total small muted"></p><div class="cw-q-list"></div><div class="cw-controls"></div></div>';
      button(this.querySelector('.cw-controls'), '清空问题', () => this.cwReset());
      this.addEventListener('click', (e) => {
        const card = e.target.closest('[data-k]');
        if (!card) return;
        e.stopPropagation();
        const q = this._find(card.getAttribute('data-k'));
        if (e.target.closest('.cw-q-hide')) {
          q.hidden = true;
          if (this._now === q.k) this._now = null;
        } else if (this._now === q.k) {
          this._now = null;
        } else {
          this._now = q.k;
          q.done = true;
        }
        this._changed();
      });
      this._render();
      room().then(
        (r) => {
          r.on('data', ({ from, value }) => {
            if (!value || value.id !== this._id) return;
            if (value.sync) {
              const mine = this._qs.filter((q) => q.voters.has(from)).map((q) => q.k);
              r.send({ id: this._id, qs: this._public(), mine }, from);
            } else if (typeof value.ask === 'string' && typeof value.k === 'string' && !this._find(value.k)) {
              const text = value.ask.trim().slice(0, 120);
              if (!text) return;
              this._qs.push({ k: value.k, text, voters: new Set(), done: false, hidden: false, t: Date.now() });
              this._changed();
            } else if (typeof value.vote === 'string') {
              const q = this._find(value.vote);
              if (!q) return;
              if (value.on) q.voters.add(from);
              else q.voters.delete(from);
              this._changed();
            }
          });
          // Phones open the question list on this slide.
          onSlideEnter(this, () => r.show('<script>window.liveOpenQuestions = true;</' + 'script>'));
          if (this.hasAttribute('qr')) addQr(this, 260);
        },
        () => offline(this.querySelector('.cw-live-total')),
      );
    }

    _find(k) {
      return this._qs.filter((q) => q.k === k)[0];
    }

    _sorted() {
      return this._qs.filter((q) => !q.hidden).sort((a, b) => b.voters.size - a.voters.size || a.t - b.t);
    }

    _public() {
      return this._sorted().map((q) => ({
        k: q.k,
        text: q.text,
        n: q.voters.size,
        done: q.done,
        now: q.k === this._now,
      }));
    }

    _changed() {
      this._render();
      this._broadcast();
    }

    cwReset() {
      this._qs = [];
      this._now = null;
      this._changed();
    }

    _render() {
      const qs = this._sorted();
      const now = this._now ? this._find(this._now) : null;
      this.querySelector('.cw-q-now').innerHTML = now
        ? `<div class="cw-q-card cw-on" data-k="${esc(now.k)}"><span class="cw-q-text">${esc(now.text)}</span><span class="cw-q-votes">👍 ${now.voters.size}</span></div>`
        : '';
      this.querySelector('.cw-live-total').textContent = qs.length
        ? `${qs.length} 个问题，按点赞排序（点问题标为正在回答，× 隐藏）`
        : '还没有问题：手机上点「提问」';
      this.querySelector('.cw-q-list').innerHTML = qs
        .filter((q) => q !== now)
        .map(
          (q) =>
            `<div class="cw-q-card${q.done ? ' cw-done' : ''}" data-k="${esc(q.k)}"><span class="cw-q-text">${esc(q.text)}</span><span class="cw-q-votes">👍 ${q.voters.size}</span><button class="cw-q-hide" title="隐藏">×</button></div>`,
        )
        .join('');
    }
  }

  customElements.define('cw-live-join', LiveJoin);
  customElements.define('cw-poll', Poll);
  customElements.define('cw-responses', Responses);
  customElements.define('cw-wordcloud', WordCloud);
  customElements.define('cw-rating', Rating);
  customElements.define('cw-reactions', Reactions);
  customElements.define('cw-questions', Questions);
})();
