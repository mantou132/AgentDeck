import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { documentFixture, tick } from './helpers/app-fixture.mjs';

const source = readFileSync(new URL('../src/lib/links.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});
const exports = {};
vm.runInNewContext(outputText, {
  exports,
  URL,
  require: (id) => (id === 'tauri-plugin-edge-to-edge-api' ? { toWebproxyUrl: (url) => url } : {}),
});
const parse = (href) => {
  const result = exports.parseMessageLink(href);
  return result && JSON.parse(JSON.stringify(result));
};

test('web links retain query strings and anchors; file links retain remote paths and line references', () => {
  assert.deepEqual(parse('https://example.com/docs?q=hello#intro'), {
    type: 'web',
    url: 'https://example.com/docs?q=hello#intro',
  });
  assert.deepEqual(parse('//example.com/docs'), { type: 'web', url: 'https://example.com/docs' });
  for (const [href, path, line] of [
    ['/Users/me/src/app.ts:12:3', '/Users/me/src/app.ts', 12],
    ['src/app.ts#L42-L48', 'src/app.ts', 42],
    ['README.md:8', 'README.md', 8],
    ['../notes%20中文.md', '../notes 中文.md', undefined],
    ['~/notes.md', '~/notes.md', undefined],
    ['file:///Users/me/notes%23one.md#L5', '/Users/me/notes#one.md', 5],
    ['file:///C:/work/file.ts:9', 'C:/work/file.ts', 9],
    ['C:\\work\\file.ts:9:2', 'C:\\work\\file.ts', 9],
    ['/tmp/100%.txt', '/tmp/100%.txt', undefined],
  ]) {
    assert.deepEqual(parse(href), { type: 'file', path, ...(line ? { line } : {}) }, href);
  }
});

test('page anchors, invalid URLs, and unsupported protocols do not become remote file requests', () => {
  for (const href of [
    '',
    '#intro',
    'https://',
    'javascript:alert(1)',
    'data:text/html,hello',
    'mailto:me@example.com',
    'file://another-host/share/a.txt',
  ]) {
    assert.equal(parse(href), undefined, href);
  }
});

test('file reads use the session cwd and paired host; missing files and timeouts remain retryable', async () => {
  const f = documentFixture();
  await f.connect();
  const read = () => f.transport.agentApi.readFile('../notes.md', '/home/me/project');
  const missing = read();
  await tick();
  const request = f.requests.at(-1);
  assert.equal(request.payload.method, 'file_read');
  assert.equal(request.payload.peerId, 1);
  assert.equal(request.payload.params.path, '../notes.md');
  assert.equal(request.payload.params.cwd, '/home/me/project');
  f.deliver({ id: request.payload.id, peerId: 1, error: 'File not found' });
  await assert.rejects(missing, /File not found/);

  const timedOut = assert.rejects(read(), /timed out/i);
  await f.advance(15_000);
  await timedOut;
  const retry = read();
  await tick();
  f.reply(f.requests.at(-1), { path: '/home/me/notes.md', type: 'text', text: '# Notes' });
  assert.equal((await retry).text, '# Notes');
});

test('browseFiles sends path, cwd, type and limit, returning path, home, and entries', async () => {
  const f = documentFixture();
  await f.connect();
  const browsing = f.transport.agentApi.browseFiles('src/elements', { cwd: '/home/me/project', type: 'all' });
  await tick();
  const request = f.requests.at(-1);
  assert.equal(request.payload.method, 'file_browse');
  assert.equal(request.payload.peerId, 1);
  assert.equal(request.payload.params.path, 'src/elements');
  assert.equal(request.payload.params.cwd, '/home/me/project');
  assert.equal(request.payload.params.type, 'all');
  assert.equal(request.payload.params.limit, 200);
  f.reply(request, {
    path: '/home/me/project/src/elements',
    home: '/home/me',
    entries: [
      { name: 'sub', path: '/home/me/project/src/elements/sub', isDirectory: true },
      { name: 'file.ts', path: '/home/me/project/src/elements/file.ts', isDirectory: false },
    ],
  });
  const result = await browsing;
  assert.equal(result.path, '/home/me/project/src/elements');
  assert.equal(result.home, '/home/me');
  assert.deepEqual(JSON.parse(JSON.stringify(result.entries)), [
    { name: 'sub', path: '/home/me/project/src/elements/sub', isDirectory: true },
    { name: 'file.ts', path: '/home/me/project/src/elements/file.ts', isDirectory: false },
  ]);
});

test('file browser navigation resolves correct breadcrumbs and parent path', () => {
  const pathSource = readFileSync(new URL('../src/lib/path.ts', import.meta.url), 'utf8');
  const { outputText: pathJs } = ts.transpileModule(pathSource, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  });
  const pathExports = {};
  vm.runInNewContext(pathJs, { exports: pathExports });

  const { getBreadcrumbs, getParentPath } = pathExports;

  const crumbs = getBreadcrumbs('/Users/mantou/agent-deck/src/elements', '/Users/mantou');
  assert.deepEqual(JSON.parse(JSON.stringify(crumbs)), [
    { name: '~', path: '/Users/mantou' },
    { name: 'agent-deck', path: '/Users/mantou/agent-deck' },
    { name: 'src', path: '/Users/mantou/agent-deck/src' },
    { name: 'elements', path: '/Users/mantou/agent-deck/src/elements' },
  ]);

  const homeCrumbs = getBreadcrumbs('/Users/mantou', '/Users/mantou');
  assert.deepEqual(JSON.parse(JSON.stringify(homeCrumbs)), [{ name: '~', path: '/Users/mantou' }]);

  const rootCrumbs = getBreadcrumbs('/etc/nginx');
  assert.deepEqual(JSON.parse(JSON.stringify(rootCrumbs)), [
    { name: '/', path: '/' },
    { name: 'etc', path: '/etc' },
    { name: 'nginx', path: '/etc/nginx' },
  ]);

  assert.equal(getParentPath('/Users/mantou/agent-deck'), '/Users/mantou');
  assert.equal(getParentPath('/Users'), '/');
  assert.equal(getParentPath('/'), null);
});
