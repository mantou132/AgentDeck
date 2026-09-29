import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/markdown.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});
const exports = {};
class MockRenderer {}
class MockCSSStyleSheet {
  replaceSync() {}
}
const mockProxy = new Proxy({}, { get: () => '' });

vm.runInNewContext(outputText, {
  exports,
  require: () => ({
    Renderer: MockRenderer,
    agentDeckTheme: mockProxy,
    isSmallTextFile: () => true,
  }),
  RegExp,
  CSSStyleSheet: MockCSSStyleSheet,
  globalThis: {},
});

const isCodeBlockClosed = exports.isCodeBlockClosed;

test('isCodeBlockClosed: identifies closed fenced code blocks correctly', () => {
  assert.equal(isCodeBlockClosed('```js\nconst a = 1;\n```'), true);
  assert.equal(isCodeBlockClosed('```js\nconst a = 1;\n```\n'), true);
  assert.equal(isCodeBlockClosed('```js\nconst a = 1;\n   ```'), true);
  assert.equal(isCodeBlockClosed('~~~python\nprint(1)\n~~~'), true);
  assert.equal(isCodeBlockClosed('````md\n```\n````'), true);
  assert.equal(isCodeBlockClosed('    indented code block'), true);
});

test('isCodeBlockClosed: identifies unclosed code blocks correctly', () => {
  assert.equal(isCodeBlockClosed('```js'), false);
  assert.equal(isCodeBlockClosed('```js\n'), false);
  assert.equal(isCodeBlockClosed('```js\nconst a = 1;'), false);
  assert.equal(isCodeBlockClosed('```js\nconst a = 1;\n'), false);
  assert.equal(isCodeBlockClosed('```js\nconst a = 1;\n``'), false);
  assert.equal(isCodeBlockClosed('````md\n```\n'), false);
  assert.equal(isCodeBlockClosed('~~~python\nprint(1)\n~'), false);
});

test('closed agentdeck-chart blocks render as charts with the JSON in an escaped attribute', () => {
  const { code } = exports.markdownExtensions[0].renderer;
  const text = '{"style":"bar","series":[{"values":[1]}]}';
  assert.equal(
    code.call({}, { text, lang: 'agentdeck-chart', raw: `\`\`\`agentdeck-chart\n${text}\n\`\`\`` }),
    '<deck-chart source="{&quot;style&quot;:&quot;bar&quot;,&quot;series&quot;:[{&quot;values&quot;:[1]}]}"></deck-chart>',
  );
  const streaming = code.call({}, { text, lang: 'agentdeck-chart', raw: `\`\`\`agentdeck-chart\n${text}` });
  assert.doesNotMatch(streaming, /<deck-chart/);
});
