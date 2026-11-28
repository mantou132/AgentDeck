import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/follow-bottom.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});

function fixture({ active = true, integerScrollTop = false } = {}) {
  const frames = new Map();
  const observers = [];
  let nextFrame = 0;
  let now = 0;
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    AbortController,
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
    writes = 0;
    scrollHeight = 1000;
    clientHeight = 200;
    get scrollTop() {
      return this.#top;
    }
    set scrollTop(value) {
      this.writes += 1;
      const clamped = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)));
      this.#top = integerScrollTop ? Math.floor(clamped) : clamped;
    }
    /** Simulates native scrolling (including iOS overscroll when `raw` is true) without counting as a programmatic write. */
    scroll(value, { raw = false } = {}) {
      this.#top = raw ? value : Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)));
      this.dispatchEvent(new Event('scroll'));
    }
    touchStart() {
      this.dispatchEvent(new Event('touchstart'));
    }
    touchEnd(remainingTouches = 0) {
      const event = new Event('touchend');
      event.touches = { length: remainingTouches };
      this.dispatchEvent(event);
    }
    wheel(deltaY) {
      const event = new Event('wheel');
      event.deltaY = deltaY;
      this.dispatchEvent(event);
    }
    pointerDown(pointerType = 'mouse') {
      const event = new Event('pointerdown');
      event.pointerType = pointerType;
      this.dispatchEvent(event);
    }
  }
  const viewport = new Viewport();
  const content = {};
  const awayChanges = [];
  const controller = exports.followBottom(viewport, content, {
    onAwayChange: (away) => awayChanges.push(away),
    isActive: () => active,
  });
  return {
    viewport,
    content,
    awayChanges,
    controller,
    frames,
    observers,
    setActive(value) {
      active = value;
    },
    flush(stepMs = 16.67) {
      now += stepMs;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(now);
    },
    settle(stepMs = 16.67) {
      for (let i = 0; i < 200 && frames.size; i++) this.flush(stepMs);
      assert.equal(frames.size, 0);
    },
    resize(target = content) {
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback();
      }
    },
  };
}

test('initial display and delayed first-frame render jump immediately, then line-by-line growth glides smoothly', () => {
  const f = fixture();
  assert.equal(f.viewport.scrollTop, 800);
  // Delayed child rendering before the initial jump frame clears still pins immediately without gliding.
  f.viewport.scrollHeight = 1120;
  f.resize();
  assert.equal(f.viewport.scrollTop, 920);
  f.flush();
  assert.equal(f.frames.size, 0);

  // Incremental streaming growth within one viewport height glides smoothly and coalesces into one rAF.
  f.viewport.scrollHeight = 1220;
  f.resize();
  f.resize();
  assert.equal(f.frames.size, 1);

  f.flush();
  assert.ok(f.viewport.scrollTop > 920 && f.viewport.scrollTop < 1020);
  f.viewport.scrollHeight = 1260;
  f.resize();
  assert.equal(f.frames.size, 1);

  f.settle();
  assert.ok(Math.abs(f.viewport.scrollTop - 1060) <= 0.5);

  f.viewport.clientHeight = 120;
  f.resize(f.viewport);
  f.settle();
  assert.ok(Math.abs(f.viewport.scrollTop - 1140) <= 0.5);
});

test('large content jumps and far resume() skip straight to bottom without sweeping intermediate history', () => {
  const f = fixture();
  f.flush();

  // Large batch growth exceeding one viewport height jumps immediately instead of animating across pages.
  f.viewport.scrollHeight = 3000;
  f.resize();
  assert.equal(f.viewport.scrollTop, 2800);
  assert.equal(f.frames.size, 0);

  // Clicking jump-to-latest from far up (> 1 viewport) jumps directly without sweeping past offscreen cards.
  f.viewport.scroll(200);
  f.controller.resume(true);
  assert.equal(f.viewport.scrollTop, 2800);
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.awayChanges, [false, true, false]);

  // History replay via resume() keeps instant pinning through the next frame even if child content grows late.
  f.viewport.scroll(0);
  f.viewport.scrollHeight = 200;
  f.controller.resume();
  f.viewport.scrollHeight = 320;
  f.resize();
  assert.equal(f.viewport.scrollTop, 120);
  f.flush();
  assert.equal(f.frames.size, 0);
});

test('1x DPR integer scrollTop rounding still settles cleanly without stalling', () => {
  const f = fixture({ integerScrollTop: true });
  f.flush();
  f.viewport.scrollHeight = 1024;
  f.resize();
  f.settle(8.33);
  assert.equal(f.viewport.scrollTop, 824);
});

test('slight or slow upward scroll immediately cancels following without snapping back or flickering jump button', () => {
  const f = fixture();
  f.flush();
  assert.equal(f.viewport.scrollTop, 800);
  const writesBefore = f.viewport.writes;

  // Slow 1px-by-1px upward scroll must never be pulled back to the bottom.
  for (let top = 799; top >= 790; top--) {
    f.viewport.scroll(top);
  }
  assert.equal(f.viewport.scrollTop, 790);
  assert.equal(f.viewport.writes, writesBefore);
  assert.equal(f.frames.size, 0);
  // Within 48px of bottom, jump button stays hidden to avoid flicker.
  assert.deepEqual(f.awayChanges, [false]);

  // Content growing while paused preserves the user's spot and reveals the jump button once past 48px.
  f.viewport.scrollHeight = 1050;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 790);
  assert.equal(f.viewport.writes, writesBefore);
  assert.deepEqual(f.awayChanges, [false, true]);
});

test('scrolling back down near the bottom silently resumes following without writing scrollTop', () => {
  const f = fixture();
  f.flush();
  f.viewport.scroll(500);
  assert.deepEqual(f.awayChanges, [false, true]);

  const writesBefore = f.viewport.writes;
  // Moving down within 48px hides the jump button before re-engaging following.
  f.viewport.scroll(770);
  assert.deepEqual(f.awayChanges, [false, true, false]);

  // Still paused above 8px.
  f.viewport.scrollHeight = 1020;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 770);

  // Reaching within 8px while scrolling down resumes following passively with zero programmatic scroll writes.
  f.viewport.scroll(815);
  assert.equal(f.viewport.scrollTop, 815);
  assert.equal(f.viewport.writes, writesBefore);
  assert.equal(f.frames.size, 0);

  // Subsequent growth within one viewport smoothly chases the new bottom.
  f.viewport.scrollHeight = 1120;
  f.resize();
  f.settle();
  assert.ok(Math.abs(f.viewport.scrollTop - 920) <= 0.5);
});

test('iOS bottom overscroll bounce and shrinking content do not cancel following', () => {
  const f = fixture();
  f.flush();
  // Pull past bottom (overscroll) and bounce back to maxScrollTop.
  f.viewport.scroll(830, { raw: true });
  f.viewport.scroll(810, { raw: true });
  f.viewport.scroll(800, { raw: true });

  // Collapsing content shrinks scrollHeight and clamps scrollTop downward.
  f.viewport.scrollHeight = 700;
  f.viewport.scroll(500);

  f.viewport.scrollHeight = 820;
  f.resize();
  f.settle();
  assert.ok(Math.abs(f.viewport.scrollTop - 620) <= 0.5);
});

test('touch pauses active smooth chasing; quick tap resumes smoothly while holding freezes reading spot', () => {
  const f = fixture();
  f.flush();
  // Quick tap with minor growth glides to the new bottom on release.
  f.viewport.touchStart();
  f.viewport.scrollHeight = 1016;
  f.resize();
  assert.equal(f.frames.size, 0);
  assert.equal(f.viewport.scrollTop, 800);
  f.viewport.touchEnd();
  assert.equal(f.frames.size, 1);
  f.settle();
  assert.ok(Math.abs(f.viewport.scrollTop - 816) <= 0.5);

  // Holding while substantial content streams underneath keeps the user's spot on release.
  f.viewport.touchStart();
  f.viewport.scrollHeight = 1120;
  f.resize();
  assert.equal(f.frames.size, 0);
  f.viewport.touchEnd();
  assert.equal(f.frames.size, 0);
  assert.ok(Math.abs(f.viewport.scrollTop - 816) <= 0.5);
  assert.deepEqual(f.awayChanges, [false, true]);
});

test('touchEnd with no growth does not redundantly write scrollTop or start rAF', () => {
  const f = fixture();
  f.flush();
  const writesBefore = f.viewport.writes;
  f.viewport.touchStart();
  f.viewport.touchEnd();
  assert.equal(f.viewport.writes, writesBefore);
  assert.equal(f.frames.size, 0);
});

test('nearby smooth resume glides within one viewport and can be interrupted by user input', () => {
  const f = fixture();
  f.flush();
  // Within one viewport (150px away <= 200px clientHeight), smooth resume glides.
  f.viewport.scroll(650);
  assert.deepEqual(f.awayChanges, [false, true]);
  f.controller.resume(true);
  assert.deepEqual(f.awayChanges, [false, true, false]);
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.ok(f.viewport.scrollTop > 650 && f.viewport.scrollTop < 800);

  // Instant resume skips an in-flight smooth animation.
  f.controller.resume();
  assert.equal(f.viewport.scrollTop, 800);
  f.flush();
  assert.equal(f.frames.size, 0);

  // Upward wheel immediately cancels an in-flight rAF before scroll fires.
  f.viewport.scroll(650);
  f.controller.resume(true);
  f.flush();
  const wheelPos = f.viewport.scrollTop;
  f.viewport.wheel(-10);
  assert.equal(f.frames.size, 0);
  f.viewport.scroll(wheelPos - 10);
  assert.deepEqual(f.awayChanges.at(-1), true);

  // Clicking during a smooth glide stops it cleanly.
  f.viewport.scroll(650);
  f.controller.resume(true);
  f.flush();
  f.viewport.pointerDown('mouse');
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.awayChanges.at(-1), true);

  // Touching mid-glide stops it and preserves the position on release.
  f.viewport.scroll(650);
  f.controller.resume(true);
  f.flush();
  const touchStop = f.viewport.scrollTop;
  f.viewport.touchStart();
  assert.equal(f.frames.size, 0);
  f.viewport.touchEnd();
  assert.equal(f.viewport.scrollTop, touchStop);
  assert.deepEqual(f.awayChanges.at(-1), true);
});

test('shrinking content so everything fits re-enables following and hides jump button', () => {
  const f = fixture();
  f.flush();
  f.viewport.scroll(100);
  assert.deepEqual(f.awayChanges, [false, true]);

  f.viewport.scrollHeight = 180;
  f.viewport.scroll(0);
  f.resize();
  assert.deepEqual(f.awayChanges, [false, true, false]);

  f.viewport.scrollHeight = 320;
  f.resize();
  f.settle();
  assert.ok(Math.abs(f.viewport.scrollTop - 120) <= 0.5);
});

test('inactive content stays in place on opening and resizing, then follows active updates', () => {
  const f = fixture({ active: false });
  assert.equal(f.viewport.scrollTop, 0);
  f.viewport.scrollHeight = 1400;
  f.resize();
  f.viewport.clientHeight = 120;
  f.resize(f.viewport);
  assert.equal(f.frames.size, 0);
  assert.equal(f.viewport.scrollTop, 0);

  f.setActive(true);
  f.viewport.scrollHeight = 1600;
  f.resize();
  assert.equal(f.viewport.scrollTop, 1480);
});

test('finishing an update cancels an active chase and ignores subsequent resizes', () => {
  const f = fixture();
  f.flush();
  f.viewport.scrollHeight = 1120;
  f.resize();
  f.setActive(false);
  f.flush();
  assert.equal(f.viewport.scrollTop, 800);
  assert.equal(f.frames.size, 0);

  f.viewport.scrollHeight = 1500;
  f.resize();
  assert.equal(f.frames.size, 0);
  assert.equal(f.viewport.scrollTop, 800);
});

test('pausing manually stays effective when updates stop and restart', () => {
  const f = fixture();
  f.flush();
  f.viewport.scroll(100);
  f.setActive(false);
  f.setActive(true);
  f.viewport.scrollHeight = 1500;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 100);
  assert.deepEqual(f.awayChanges, [false, true]);
});

test('cleanup cancels pending animations and removes all listeners via AbortController', () => {
  const f = fixture();
  f.flush();
  f.viewport.scrollHeight = 1120;
  f.resize();
  assert.equal(f.frames.size, 1);

  f.controller.disconnect();
  assert.equal(f.frames.size, 0);
  assert.ok(f.observers.every((observer) => observer.targets.size === 0));

  const awayCount = f.awayChanges.length;
  f.viewport.scroll(50);
  f.viewport.scrollHeight = 1600;
  f.resize();
  assert.equal(f.frames.size, 0);
  assert.equal(f.viewport.scrollTop, 50);
  assert.equal(f.awayChanges.length, awayCount);
});
