import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const relayId = '01234567-89ab-cdef-0123-456789abcdef';
export const settingsKey = 'agentdeck.settings.v1';
export const deviceKey = 'agentdeck.device_id.v1';
export const resetKey = 'agentdeck.reset_pending.v1';
export const relayKey = 'relay-client.v1';
const compiledModules = new Map();
export const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

// Each fixture is a new document/module realm. Only browser storage and the
// simulated host survive reload; use the installed Relay SDK and App source.
export function documentFixture(previous) {
  const localStorage = previous?.localStorage ?? memoryStorage();
  const sessionStorage = previous?.sessionStorage ?? memoryStorage();
  const host = previous?.host ?? { sequence: 0 };
  if (!previous) {
    localStorage.setItem(settingsKey, JSON.stringify({ relayId, agent: 'codex' }));
    localStorage.setItem('unrelated.preference', 'keep');
  }
  const sockets = [];
  const requests = [];
  const heldMethods = new Set();
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  let reloads = 0;

  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor(url) {
      super();
      this.url = String(url);
      sockets.push(this);
    }
    send(data) {
      const frame = JSON.parse(data);
      this.sent.push(frame);
      if (frame.type === 'message') requests.push(frame);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
    frame(frame) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      this.frame({ type: 'ready', endpoint: '2' });
    }
  }

  const window = new EventTarget();
  window.location = { reload: () => reloads++ };
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const context = vm.createContext({
    console,
    crypto,
    Map,
    Set,
    URL,
    TextEncoder,
    localStorage,
    sessionStorage,
    WebSocket: Socket,
    window,
    document,
    process: { env: { NODE_ENV: 'development' } },
    setTimeout: (fn, delay) => {
      timers.set(++timerId, { fn, delay, at: now + delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    createStore: (initial) => {
      const state = (patch) => Object.assign(state, patch);
      return Object.assign(state, initial);
    },
  });
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    if (!compiledModules.has(file)) {
      compiledModules.set(
        file,
        ts.transpileModule(readFileSync(file, 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
        }).outputText,
      );
    }
    const run = vm.runInContext(`(function(require,module,exports){${compiledModules.get(file)}\n})`, context, {
      filename: file,
    });
    run(
      (name) =>
        load(
          name === 'relay-client-ts'
            ? path.join(root, 'node_modules/relay-client-ts/src/relay-client.ts')
            : path.resolve(path.dirname(file), `${name}.ts`),
        ),
      module,
      module.exports,
    );
    return module.exports;
  }
  const app = load(path.join(root, 'src/store.ts'));
  const remoteSession = { sessionId: 's1', cwd: '/tmp', agent: 'codex', title: 'Reset test' };
  const processed = new Set();
  const deliver = (payload) => {
    const sequence = ++host.sequence;
    sockets.at(-1).frame({ type: 'message', message_id: `host-${sequence}`, sequence, payload });
  };
  const reply = (request, result) => deliver({ id: request.payload.id, result, peerId: 1 });
  async function settleHost() {
    for (let pass = 0; pass < 12; pass++) {
      await tick();
      for (const request of [...requests]) {
        const { method } = request.payload;
        if (!method || processed.has(request.message_id) || heldMethods.has(method)) continue;
        const results = {
          peer_attach: { peerId: 1 },
          agent_list: { agents: [{ id: 'codex', name: 'Codex' }] },
          agent_session_list: { sessions: [remoteSession] },
          agent_session_close: { closed: true },
          agent_session_load: { sessionId: 's1', agent: 'codex' },
          agent_session_create: { sessionId: 'created', agent: 'codex' },
        };
        if (!(method in results)) continue;
        processed.add(request.message_id);
        sockets.at(-1).frame({ type: 'stored', message_id: request.message_id });
        reply(request, results[method]);
      }
    }
    await tick();
  }
  async function connect() {
    app.startApp();
    sockets.at(-1).open();
    await settleHost();
  }
  async function openSession() {
    const loading = app.ensureSessionLoaded('s1');
    await settleHost();
    await loading;
    assert.equal(app.isSessionOpened('s1'), true);
  }

  return {
    app,
    transport: load(path.join(root, 'src/transport.ts')),
    rpc: load(path.join(root, 'src/rpc.ts')),
    window,
    document,
    timers,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.fn();
        await tick();
      }
      now = end;
      await tick();
    },
    localStorage,
    sessionStorage,
    host,
    sockets,
    requests,
    heldMethods,
    deliver,
    reply,
    connect,
    openSession,
    settleHost,
    get reloads() {
      return reloads;
    },
  };
}
