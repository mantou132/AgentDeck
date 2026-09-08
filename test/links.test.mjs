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
vm.runInNewContext(outputText, { exports, URL });
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
