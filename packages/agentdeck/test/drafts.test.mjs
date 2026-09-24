import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/composer/drafts.ts', import.meta.url), 'utf8');
const databaseSource = readFileSync(new URL('../src/lib/database.ts', import.meta.url), 'utf8');
const databaseOutput = ts.transpileModule(databaseSource, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});

const config = {};
vm.runInNewContext(
  ts.transpileModule(readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText,
  { exports: config, require: () => ({}) },
);

// Browser storage survives document/module reloads. Requests and transaction
// completion are asynchronous, including requests added from success handlers.
function storage() {
  const records = new Map();
  let failNext = false;
  const db = {
    transaction() {
      let aborted = false;
      const tx = {
        abort: () => {
          aborted = true;
          queueMicrotask(() => tx.onabort());
        },
      };
      let requests = 0;
      const request = (operation) => {
        const result = {};
        requests++;
        queueMicrotask(() => {
          if (failNext) {
            failNext = false;
            tx.error = new Error('Storage full');
            tx.onabort();
            return;
          }
          result.result = structuredClone(operation());
          result.onsuccess?.();
          if (--requests === 0 && !aborted) queueMicrotask(() => tx.oncomplete());
        });
        return result;
      };
      tx.objectStore = () => ({
        transaction: tx,
        get: (key) => request(() => records.get(key)),
        getAll: () => request(() => [...records.values()]),
        put: (value, key) =>
          request(() => {
            records.set(key ?? value.sessionId, structuredClone(value));
            return key;
          }),
        delete: (key) =>
          request(() => {
            records.delete(key);
          }),
        clear: () => request(() => records.clear()),
      });
      return tx;
    },
  };
  return {
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
    fail: () => {
      failNext = true;
    },
  };
}

function load(indexedDB) {
  const exports = {};
  const database = {};
  vm.runInNewContext(databaseOutput, { exports: database, indexedDB, setTimeout, clearTimeout });
  vm.runInNewContext(outputText, { exports, require: (name) => (name === '../config' ? config : database) });
  return exports;
}

const draft = {
  text: '  Review [Paste #1]\n',
  attachments: [
    {
      id: 'paste',
      kind: 'text',
      name: 'Paste #1',
      marker: '[Paste #1]',
      pasteReference: 1,
      text: 'Long pasted content',
    },
    {
      id: 'image',
      kind: 'image',
      name: 'screen.png',
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      previewUrl: 'data:image/png;base64,aW1hZ2U=',
    },
  ],
};

test('existing drafts use the globally unique session ID; new drafts use agent and directory', () => {
  const { draftKey } = load(storage());
  const session = { agent: 'codex', sessionId: 's1', cwd: '/project' };
  assert.equal(draftKey(session), 's1');
  assert.equal(draftKey({ ...session, agent: 'claude', title: 'renamed' }), 's1');
  assert.notEqual(draftKey({ ...session, sessionId: 's2' }), 's1');
  const pendingSession = { ...session, sessionId: 'pending-session', pendingCreation: true };
  assert.notEqual(draftKey(pendingSession), draftKey({ ...pendingSession, agent: 'claude' }));
  assert.notEqual(draftKey(pendingSession), draftKey({ ...pendingSession, cwd: '/other' }));
});

test('reopening after restart preserves whitespace, attachment content and paste markers', async () => {
  const disk = storage();
  const app = load(disk);
  await app.saveDraft('s1', draft);
  await app.saveDraft('s2', { text: 'Other session', attachments: [] });
  const restarted = load(disk);
  assert.deepEqual(await restarted.readDraft('s1'), draft);
  assert.equal((await restarted.readDraft('s2')).text, 'Other session');
});

test('rapid edits are ordered before reopening; clearing and deleting leave other sessions intact', async () => {
  const app = load(storage());
  const writes = [app.saveDraft('s1', draft), app.saveDraft('s1', { text: 'Latest', attachments: [] })];
  assert.equal((await app.readDraft('s1')).text, 'Latest');
  await Promise.all(writes);
  await app.saveDraft('s2', draft);
  await app.saveDraft('s1', { text: '', attachments: [] });
  assert.equal(await app.readDraft('s1'), undefined);
  assert.deepEqual(await app.readDraft('s2'), draft);
  await app.removeDraft('s2');
  assert.equal(await app.readDraft('s2'), undefined);
});

test('failed submission restores an empty draft but never overwrites newer input', async () => {
  const app = load(storage());
  assert.deepEqual(await app.restoreDraft('s1', draft), draft);
  const newer = { text: 'Next question', attachments: [] };
  await app.saveDraft('s1', newer);
  assert.deepEqual(await app.restoreDraft('s1', draft), newer);
  assert.deepEqual(await app.readDraft('s1'), newer);
});

test('storage errors surface and a later edit can retry; reset clears every session', async () => {
  const disk = storage();
  const app = load(disk);
  disk.fail();
  await assert.rejects(app.saveDraft('s1', draft), /Storage full/);
  await app.saveDraft('s1', draft);
  await app.saveDraft('s2', draft);
  await app.clearDrafts();
  const restarted = load(disk);
  assert.equal(await restarted.readDraft('s1'), undefined);
  assert.equal(await restarted.readDraft('s2'), undefined);
});

function composerFixture() {
  const effects = [];
  const templates = [];
  const loads = new Map();
  const saves = [];
  let state;
  const fieldHook = (list) => () => (_, context) => (initial) => {
    list.push({ name: context.name, run: initial });
    return initial;
  };
  const noop = () => {};
  const exports = {};
  const composer = readFileSync(new URL('../src/elements/composer.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(composer, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      if (name === '../composer/drafts')
        return {
          readDraft: (key) => new Promise((resolve) => loads.set(key, resolve)),
          saveDraft: async (key, draft) => {
            saves.push({ key, draft });
          },
        };
      if (name === '../i18n') return { i18n: { get: (key) => key } };
      if (name === '../composer/references') return { syncPasteReferences: (_, attachments) => attachments };
      if (name === '../composer/files') return { MAX_ATTACHMENTS: 10 };
      if (name === '../styles/icons') return { icons: {} };
      return {};
    },
    GemElement: class {},
    customElement: () => noop,
    adoptedStyle: () => noop,
    property: noop,
    boolattribute: noop,
    emitter: () => () => noop,
    effect: fieldHook(effects),
    template: fieldHook(templates),
    createState: (initial) => {
      state = Object.assign((next) => Object.assign(state, next), initial);
      return state;
    },
    createRef: () => ({}),
    css: () => '',
    html: (strings, ...values) => ({ strings, values }),
  });
  const element = new exports.DeckComposerElement();
  return {
    element,
    state,
    loads,
    saves,
    open(key) {
      element.sessionKey = key;
      element.draftKey = key;
      return effects.find((item) => item.name === '#resetInput').run();
    },
    input(text) {
      const rendered = templates[0].run();
      const index = rendered.strings.findIndex((part) => part.endsWith('@input='));
      rendered.values[index]({ target: { value: text } });
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('switching sessions restores the target draft and keeps subsequent input on that session', async () => {
  const f = composerFixture();
  f.open('s1');
  f.loads.get('s1')(draft);
  await settle();
  f.open('s2');
  f.loads.get('s2')({ text: 'Session two', attachments: [] });
  await settle();
  assert.equal(f.state.draft, 'Session two');
  assert.equal(f.state.attachments.length, 0);
  f.input('New edit');
  assert.equal(f.saves.at(-1).key, 's2');
  assert.equal(f.saves.at(-1).draft.text, 'New edit');
  f.element.restoreIfEmpty('s1', draft);
  f.element.restoreIfEmpty('s2', draft);
  assert.equal(f.state.draft, 'New edit');
});

test('loading a saved draft restores attachments without writing it back or losing markers', async () => {
  const f = composerFixture();
  f.open('s1');
  f.loads.get('s1')(draft);
  await settle();
  assert.equal(f.state.draft, draft.text);
  assert.deepEqual(f.state.attachments, draft.attachments);
  assert.equal(f.state.loadingDraft, false);
  assert.equal(f.saves.length, 0);
});

test('shared database supports existing in-flight inline keys and atomic message updates', async () => {
  const exports = {};
  vm.runInNewContext(databaseOutput, { exports, indexedDB: storage(), setTimeout, clearTimeout });
  const records = exports.createDatabaseStore(config.DATABASES.inFlight);
  await records.set('s1', { sessionId: 's1', messages: [] });
  await records.update('s1', (record) => ({ ...record, messages: ['answer'] }));
  await records.update('missing', () => undefined);
  assert.deepEqual(await records.getAll(), [{ sessionId: 's1', messages: ['answer'] }]);
  await records.delete('s1');
  assert.equal((await records.getAll()).length, 0);
});

test('a rejected atomic updater preserves the record and does not block subsequent writes', async () => {
  const exports = {};
  vm.runInNewContext(databaseOutput, { exports, indexedDB: storage(), setTimeout, clearTimeout });
  const records = exports.createDatabaseStore({ name: 'test', version: 1, storeName: 'records' });
  await records.set('s1', { text: 'Keep' });
  await assert.rejects(
    records.update('s1', () => {
      throw new Error('Update failed');
    }),
    /Update failed/,
  );
  assert.deepEqual(await records.get('s1'), { text: 'Keep' });
  await records.set('s1', { text: 'Retry' });
  assert.deepEqual(await records.get('s1'), { text: 'Retry' });
});
