import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const relayId = '01234567-89ab-cdef-0123-456789abcdef';
const settingsKey = 'agentdeck.settings.v1';
const deviceKey = 'agentdeck.device_id.v1';
const resetKey = 'agentdeck.reset_pending.v1';
const relayKey = 'relay-client.v1';
const compiledModules = new Map();
const tick = async () => {
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
function documentFixture(previous) {
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
      timers.set(++timerId, { fn, delay });
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

for (const operation of ['loading', 'creating', 'prompt', 'permission']) {
  test(`reset during ${operation} reloads a clean App that can close/load and prompt again`, async () => {
    const old = documentFixture();
    await old.connect();
    if (operation === 'loading') {
      old.heldMethods.add('agent_session_load');
      void old.app.ensureSessionLoaded('s1');
      await old.settleHost();
      assert.equal(old.app.agentdeckStore.loadingSessionIds.includes('s1'), true);
    } else if (operation === 'creating') {
      old.heldMethods.add('agent_session_create');
      const draft = old.app.createDraftSession({ agent: 'codex', cwd: '/tmp' });
      void old.app.promoteDraftSession(draft, 'old draft');
      await tick();
      assert.equal(old.app.agentdeckStore.pendingSessionIds.includes('draft'), true);
    } else {
      await old.openSession();
      old.app.sendPrompt('s1', 'old task');
      await tick();
      if (operation === 'permission') {
        old.deliver({
          id: 'old-permission',
          method: 'agent_permission_request',
          params: { agent: 'codex', sessionId: 's1', options: [{ optionId: 'allow', name: 'Allow' }] },
          peerId: 1,
        });
        await tick();
        assert.ok(old.app.agentdeckStore.permissionsBySession.s1);
      }
    }
    const staleRequest = old.requests.at(-1);
    const device = old.localStorage.getItem(deviceKey);
    const settings = old.localStorage.getItem(settingsKey);
    const requestCount = old.requests.length;
    old.app.hardResetApp();
    assert.equal(old.reloads, 1);
    assert.equal(old.sessionStorage.getItem(resetKey), 'true');
    assert.equal(old.requests.length, requestCount, 'reset does not await or send a remote close/cancel');

    // The old document can still write storage before navigation commits.
    // Cleanup must run in the new document, not before reload.
    old.localStorage.setItem(
      relayKey,
      JSON.stringify({ relayId, lastReceived: 9999, outbox: [{ messageId: 'stale', payload: staleRequest.payload }] }),
    );
    const fresh = documentFixture(old);
    await fresh.connect();
    assert.equal(fresh.sessionStorage.getItem(resetKey), null);
    assert.equal(fresh.localStorage.getItem(deviceKey), device);
    assert.equal(fresh.localStorage.getItem(settingsKey), settings);
    assert.equal(fresh.localStorage.getItem('unrelated.preference'), 'keep');
    assert.equal(new URL(fresh.sockets[0].url).searchParams.get('ack_head'), 'true');
    assert.equal(fresh.app.agentdeckStore.sessionsLoaded, true);
    assert.equal(fresh.app.agentdeckStore.pendingSessionIds.length, 0);
    assert.equal(fresh.app.agentdeckStore.loadingSessionIds.length, 0);
    assert.equal(Object.keys(fresh.app.agentdeckStore.permissionsBySession).length, 0);
    assert.equal(fresh.app.agentdeckStore.draftSession, null);
    assert.equal(
      fresh.requests.some((request) => request.message_id === 'stale'),
      false,
    );

    // A live old host may still emit replies and permission requests after reset.
    fresh.reply(staleRequest, { answer: 'old answer', sessionId: 'old-created' });
    fresh.deliver({
      id: 'late-permission',
      method: 'agent_permission_request',
      params: { agent: 'codex', sessionId: 's1' },
      peerId: 1,
    });
    await tick();
    assert.equal(Object.keys(fresh.app.agentdeckStore.messagesBySession).length, 0);
    assert.equal(Object.keys(fresh.app.agentdeckStore.permissionsBySession).length, 0);
    assert.ok(fresh.requests.find((request) => request.payload.id === 'late-permission')?.payload.error);

    await fresh.openSession();
    const methods = fresh.requests.map((request) => request.payload.method);
    assert.ok(methods.indexOf('agent_session_close') < methods.indexOf('agent_session_load'));
    assert.equal(fresh.app.sendPrompt('s1', 'new task'), true);
    await tick();
    const newPrompt = fresh.requests.find((request) => request.payload.method === 'agent_prompt');
    assert.notEqual(newPrompt.payload.id, staleRequest.payload.id);
    fresh.reply(staleRequest, { answer: 'another old answer' });
    await tick();
    assert.equal(fresh.app.agentdeckStore.pendingSessionIds.includes('s1'), true);
    fresh.reply(newPrompt, { answer: 'new answer' });
    await tick();
    assert.equal(fresh.app.agentdeckStore.pendingSessionIds.length, 0);
    assert.equal(fresh.app.agentdeckStore.messagesBySession.s1.at(-1).text, 'new answer');
    assert.equal(fresh.app.agentdeckStore.errorsBySession.s1, '');
  });
}

test('reset remains available while offline and across repeated reloads', () => {
  let current = documentFixture();
  for (let i = 0; i < 3; i++) {
    current.app.startApp();
    assert.equal(current.app.agentdeckStore.connection, 'connecting');
    current.app.hardResetApp();
    assert.equal(current.reloads, 1);
    current = documentFixture(current);
  }
});

test('failure to mark a reset is surfaced before navigation', () => {
  const app = documentFixture();
  app.sessionStorage.setItem = () => {
    throw new Error('Storage unavailable');
  };
  assert.throws(() => app.app.hardResetApp(), /Storage unavailable/);
  assert.equal(app.reloads, 0);
});

test('failed cleanup keeps the reset marker and does not replay the old outbox', async () => {
  const failed = documentFixture();
  failed.app.hardResetApp();
  failed.localStorage.setItem(relayKey, 'old queue');
  const remove = failed.localStorage.removeItem;
  failed.localStorage.removeItem = () => {
    throw new Error('Storage unavailable');
  };
  const boot = documentFixture(failed);
  boot.app.startApp();
  assert.equal(boot.sockets.length, 0);
  assert.match(boot.app.agentdeckStore.sessionsError, /重置本地连接失败/);
  assert.equal(boot.sessionStorage.getItem(resetKey), 'true');
  boot.localStorage.removeItem = remove;
  boot.app.hardResetApp();
  const recovered = documentFixture(boot);
  await recovered.connect();
  assert.equal(recovered.app.agentdeckStore.sessionsLoaded, true);
  assert.equal(recovered.sessionStorage.getItem(resetKey), null);
});

test('ordinary startup keeps the Relay store when no reset was requested', async () => {
  const fixture = documentFixture();
  fixture.localStorage.setItem(relayKey, JSON.stringify({ relayId, lastReceived: 12, outbox: [] }));
  fixture.app.startApp();
  await tick();
  assert.equal(JSON.parse(fixture.localStorage.getItem(relayKey)).lastReceived, 12);
});
