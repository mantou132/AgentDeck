import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/follow-bottom.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});

function fixture() {
  const frames = new Map();
  const observers = [];
  let nextFrame = 0;
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    requestAnimationFrame: (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class {
      targets = new Set();
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target) {
        this.targets.add(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  });
  class Viewport extends EventTarget {
    #top = 0;
    scrollHeight = 1000;
    clientHeight = 200;
    get scrollTop() {
      return this.#top;
    }
    set scrollTop(value) {
      this.#top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    }
    scroll(value) {
      this.scrollTop = value;
      this.dispatchEvent(new Event('scroll'));
    }
  }
  const viewport = new Viewport();
  const content = {};
  const changes = [];
  const controller = exports.followBottom(viewport, content, (following) => changes.push(following));
  return {
    viewport,
    content,
    changes,
    controller,
    frames,
    observers,
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
    resize(target = content) {
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback();
      }
    },
  };
}

test('initial display, delayed content growth and viewport resizing keep the bottom visible', () => {
  const f = fixture();
  f.flush();
  assert.equal(f.viewport.scrollTop, 800);
  f.viewport.scrollHeight = 1400;
  f.resize();
  f.resize();
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.viewport.scrollTop, 1200);
  f.viewport.clientHeight = 120;
  f.resize(f.viewport);
  f.flush();
  assert.equal(f.viewport.scrollTop, 1280);
});

test('scrolling up cancels a queued follow and preserves the reading position as content grows', () => {
  const f = fixture();
  f.flush();
  f.viewport.scrollHeight = 1200;
  f.resize();
  f.viewport.scroll(300);
  f.flush();
  assert.equal(f.viewport.scrollTop, 300);
  f.viewport.scrollHeight = 1500;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 300);
  assert.deepEqual(f.changes, [true, false]);
});

test('scrolling within four pixels of the bottom resumes following', () => {
  const f = fixture();
  f.flush();
  f.viewport.scroll(100);
  f.viewport.scroll(796);
  f.viewport.scrollHeight = 1300;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 1100);
  assert.deepEqual(f.changes, [true, false, true]);
});

test('jump to latest resumes a paused viewport immediately', () => {
  const f = fixture();
  f.flush();
  f.viewport.scroll(100);
  f.viewport.scrollHeight = 1500;
  f.controller.resume();
  f.flush();
  assert.equal(f.viewport.scrollTop, 1300);
  assert.deepEqual(f.changes, [true, false, true]);
});

test('cleanup cancels pending scrolling and removes resize and scroll subscriptions', () => {
  const f = fixture();
  f.controller.disconnect();
  f.flush();
  assert.equal(f.viewport.scrollTop, 0);
  f.viewport.scroll(100);
  f.resize();
  assert.equal(f.frames.size, 0);
  assert.ok(f.observers.every((observer) => observer.targets.size === 0));
  assert.deepEqual(f.changes, [true]);
});
