import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/paste.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});
const exports = {};
vm.runInNewContext(outputText, { exports });
const { createPasteReference, syncPasteReferences, expandReferenceRange } = exports;
const file = { id: 'file', name: 'notes.txt', kind: 'text', text: 'file contents' };
const pasted = createPasteReference({ id: 'paste', name: '', kind: 'text', text: 'pasted contents' }, 1);
const second = createPasteReference({ ...pasted, id: 'second', text: 'second paste' }, 2);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('deleting, undoing and redoing a reference keeps the matching attachment without losing selected files', () => {
  const references = new Map([
    [pasted.id, pasted],
    [second.id, second],
  ]);
  const initial = syncPasteReferences(`${second.marker} then ${pasted.marker}`, [file], references.values());
  assert.deepEqual(plain(initial), [file, plain(second), plain(pasted)]);
  const deleted = syncPasteReferences(`${second.marker} then `, initial, references.values());
  assert.deepEqual(plain(deleted), [file, plain(second)]);
  const undone = syncPasteReferences(`${second.marker} then ${pasted.marker}`, deleted, references.values());
  assert.deepEqual(plain(undone), plain(initial));
  const redone = syncPasteReferences(`${second.marker} then `, undone, references.values());
  assert.deepEqual(plain(redone), plain(deleted));
});

test('edits treat references as units, including partial selections and duplicate occurrences', () => {
  const input = `A${pasted.marker}B${second.marker}C${pasted.marker}D`;
  const firstEnd = 1 + pasted.marker.length;
  const secondStart = firstEnd + 1;
  const secondEnd = secondStart + second.marker.length;
  const duplicateStart = secondEnd + 1;
  const expand = (start, end, caret = false) => plain(expandReferenceRange(input, [pasted, second], start, end, caret));
  assert.deepEqual(expand(firstEnd - 1, firstEnd), { start: 1, end: firstEnd });
  assert.deepEqual(expand(1, 2), { start: 1, end: firstEnd });
  assert.deepEqual(expand(4, 4, true), { start: 1, end: firstEnd });
  assert.deepEqual(expand(4, secondStart + 3), { start: 1, end: secondEnd });
  assert.deepEqual(expand(duplicateStart + 2, duplicateStart + 3), { start: duplicateStart, end: input.length - 1 });
  assert.deepEqual(expand(firstEnd, firstEnd, true), { start: firstEnd, end: firstEnd });
  const oneCopy = syncPasteReferences(`A${pasted.marker}`, [pasted], [pasted]);
  assert.equal(oneCopy.length, 1);
});

test('restored messages retain reference identity; a new session has no previous attachment references', () => {
  const restored = plain(pasted);
  const next = createPasteReference({ ...file, id: 'next' }, restored.pasteReference + 1);
  const attachments = syncPasteReferences(`${restored.marker} ${next.marker}`, [], [restored, next]);
  assert.deepEqual(plain(attachments), [restored, plain(next)]);
  assert.notEqual(restored.marker, next.marker);
  assert.equal(syncPasteReferences(restored.marker, [], []).length, 0);
});
