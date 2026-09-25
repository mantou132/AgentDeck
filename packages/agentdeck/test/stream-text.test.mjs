import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/stream-text.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});
const exports = {};

vm.runInNewContext(outputText, {
  exports,
  Intl,
  Array,
  Math,
  Set,
});

const { nextStreamingText, registerActiveStream, unregisterActiveStream, hasActiveStream, clearActiveStreams } =
  exports;

test('nextStreamingText reveals text progressively', () => {
  const target = 'Hello world, this is a streaming response.';
  let displayed = '';

  displayed = nextStreamingText(displayed, target);
  assert.ok(displayed.length > 0);
  assert.ok(target.startsWith(displayed));

  while (displayed !== target) {
    const next = nextStreamingText(displayed, target);
    assert.ok(next.length > displayed.length);
    assert.ok(target.startsWith(next));
    displayed = next;
  }
  assert.equal(displayed, target);
});

test('nextStreamingText handles long text with emoji and unicode grapheme clusters', () => {
  const emojiSequence = '🚀👨‍👩‍👧‍👦🇨🇳🎉';
  const target = `Hello world! ${emojiSequence} 这是一个超长文本测试。`.repeat(500); // ~20k chars
  let displayed = '';

  const start = Date.now();
  let stepCount = 0;
  while (displayed !== target) {
    const next = nextStreamingText(displayed, target);
    assert.ok(next.length > displayed.length);
    assert.ok(target.startsWith(next));
    displayed = next;
    stepCount++;
  }
  const duration = Date.now() - start;
  assert.equal(displayed, target);
  assert.ok(duration < 1000, `Streaming took too long: ${duration}ms for ${stepCount} steps`);
});

test('active stream registry tracks active streams and prefix matching', () => {
  clearActiveStreams();
  assert.equal(hasActiveStream(), false);
  assert.equal(hasActiveStream('sess-1'), false);

  registerActiveStream('sess-1:msg-1');
  assert.equal(hasActiveStream(), true);
  assert.equal(hasActiveStream('sess-1'), true);
  assert.equal(hasActiveStream('sess-1:msg-1'), true);

  // Different session ID that starts with same substring should not match
  assert.equal(hasActiveStream('sess-10'), false);
  assert.equal(hasActiveStream('sess-2'), false);

  // Process step item matching
  registerActiveStream('sess-2:grp-1:item-1:output');
  assert.equal(hasActiveStream('sess-2'), true);
  assert.equal(hasActiveStream('sess-2:grp-1'), true);
  assert.equal(hasActiveStream('sess-2:grp-1:item-1'), true);
  assert.equal(hasActiveStream('sess-2:grp-2'), false);

  unregisterActiveStream('sess-1:msg-1');
  assert.equal(hasActiveStream('sess-1'), false);
  assert.equal(hasActiveStream('sess-2'), true);

  unregisterActiveStream('sess-2:grp-1:item-1:output');
  assert.equal(hasActiveStream('sess-2'), false);
  assert.equal(hasActiveStream(), false);
});
