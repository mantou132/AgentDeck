/*
 * Scan-to-answer for a classroom deck: students scan a QR code, open the AgentDeck audience page
 * (https://agentdeck.xianqiao.wang/zh/live) on their phones and answer; this page shows the results live.
 * Load after courseware.js. Needs the classroom computer and the phones online. Elements:
 *   <cw-live-join>                       QR code and how many joined
 *   <cw-poll options="…" correct="2">    single or multiple choice, also true/false
 *   <cw-responses type="number|text">    collect a number or a short text from everyone
 * Each phone gets a number (1 号, 2 号 …) that stays the same for this deck, and the toolbar's 点名 draws among
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
      this._send({ t: 'view', html });
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
          if (this._view !== null) this._send({ t: 'view', html: this._view }, message.from);
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
    el.innerHTML = '<p class="muted small">扫码互动需要联网，请检查教室电脑的网络。</p>';
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

  customElements.define('cw-live-join', LiveJoin);
  customElements.define('cw-poll', Poll);
  customElements.define('cw-responses', Responses);
})();
