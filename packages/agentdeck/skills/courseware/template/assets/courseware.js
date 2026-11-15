/*
 * Courseware engine: stage scaling, navigation (keys, clickers, swipe, toolbar), steps, multiple choice,
 * dragging, pen, timer, random picker. Plain script (no modules) so it runs from file:// in older browsers.
 */
(() => {
  const W = 1920;
  const H = 1080;
  const stage = document.getElementById('cw-stage');
  const slides = [].slice.call(stage.children).filter((el) => el.classList.contains('slide'));
  const params = new URLSearchParams(location.search);
  const showAllSteps = params.get('steps') === 'all';
  let scale = 1;
  let index = 0;
  let stepIndex = 0;
  let stepGroups = [];

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        if (key === 'text') node.textContent = attrs[key];
        else if (key === 'onclick') node.addEventListener('click', attrs[key]);
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach((child) => {
      node.appendChild(child);
    });
    return node;
  }

  /* ---------- Scaling ---------- */

  function fit() {
    scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    const x = (window.innerWidth - W * scale) / 2;
    const y = (window.innerHeight - H * scale) / 2;
    stage.style.setProperty('--cw-fit', `translate(${x}px,${y}px) scale(${scale})`);
  }

  /** Converts a pointer event to stage coordinates. */
  function stagePoint(event) {
    const rect = stage.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  }

  /* ---------- Steps ---------- */

  /** Groups [data-step] elements: numbers order them, empty values follow document order, "&" joins the previous one. */
  function collectSteps(slide) {
    const groups = {};
    let key = 0;
    [].slice.call(slide.querySelectorAll('[data-step]')).forEach((node, i) => {
      const raw = node.getAttribute('data-step');
      if (raw !== '&') {
        const value = parseFloat(raw);
        key = Number.isNaN(value) ? i + 1 : value;
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(node);
    });
    return Object.keys(groups)
      .map(Number)
      .sort((a, b) => a - b)
      .map((key) => groups[key]);
  }

  function applySteps() {
    stepGroups.forEach((group, i) => {
      group.forEach((node) => {
        node.classList.toggle('cw-hidden', i >= stepIndex);
      });
    });
  }

  /* ---------- Navigation ---------- */

  function go(target, revealAll) {
    target = Math.max(0, Math.min(slides.length - 1, target));
    slides[index].classList.remove('cw-current');
    index = target;
    const slide = slides[index];
    slide.classList.add('cw-current');
    stepGroups = collectSteps(slide);
    stepIndex = revealAll || showAllSteps ? stepGroups.length : 0;
    applySteps();
    ink.show(index);
    pageLabel.textContent = `${index + 1} / ${slides.length}`;
    if (history.replaceState) history.replaceState(null, '', `${location.search}#${index + 1}`);
    slide.dispatchEvent(new CustomEvent('cw-enter', { bubbles: true }));
  }

  function next() {
    if (stepIndex < stepGroups.length) {
      stepIndex++;
      applySteps();
    } else if (index < slides.length - 1) {
      go(index + 1);
    }
  }

  function prev() {
    if (stepIndex > 0 && !showAllSteps) {
      stepIndex--;
      applySteps();
    } else if (index > 0) {
      go(index - 1, true);
    }
  }

  function toggleFullscreen() {
    const doc = document;
    const root = doc.documentElement;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    } else {
      const request = root.requestFullscreen || root.webkitRequestFullscreen;
      if (request) request.call(root);
    }
  }

  /** Resets the current slide: manipulatives, dragged items, answers, steps and ink. */
  function resetSlide() {
    const slide = slides[index];
    [].slice.call(slide.querySelectorAll('*')).forEach((node) => {
      if (typeof node.cwReset === 'function') node.cwReset();
    });
    stepGroups = collectSteps(slide);
    [].slice.call(slide.querySelectorAll('[data-drag]')).forEach((node) => {
      node.style.transform = '';
      node.classList.remove('cw-right', 'cw-wrong');
    });
    [].slice.call(slide.querySelectorAll('.cw-right, .cw-wrong')).forEach((node) => {
      node.classList.remove('cw-right', 'cw-wrong');
    });
    stepIndex = showAllSteps ? stepGroups.length : 0;
    applySteps();
    ink.clear();
  }

  /* ---------- Multiple choice ---------- */

  stage.addEventListener('click', (event) => {
    const item = event.target.closest('.choices > li');
    if (!item) return;
    const marked = item.classList.contains('cw-right') || item.classList.contains('cw-wrong');
    item.classList.remove('cw-right', 'cw-wrong');
    if (!marked) item.classList.add(item.hasAttribute('data-correct') ? 'cw-right' : 'cw-wrong');
  });

  /* ---------- Dragging: [data-drag], optional [data-drop] targets ---------- */

  function translateOf(node) {
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node.style.transform);
    return match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : { x: 0, y: 0 };
  }

  stage.addEventListener('pointerdown', (event) => {
    const item = event.target.closest('[data-drag]');
    if (!item || ink.active) return;
    event.preventDefault();
    event.stopPropagation();
    const start = stagePoint(event);
    const origin = translateOf(item);
    const snap = parseFloat(item.getAttribute('data-snap')) || 0;
    item.classList.add('cw-dragging');
    item.classList.remove('cw-right', 'cw-wrong');
    item.setPointerCapture(event.pointerId);

    function move(e) {
      const p = stagePoint(e);
      let x = origin.x + p.x - start.x;
      let y = origin.y + p.y - start.y;
      if (snap) {
        x = Math.round(x / snap) * snap;
        y = Math.round(y / snap) * snap;
      }
      item.style.transform = `translate(${x}px, ${y}px)`;
    }

    function up(e) {
      item.classList.remove('cw-dragging');
      item.removeEventListener('pointermove', move);
      item.removeEventListener('pointerup', up);
      item.removeEventListener('pointercancel', up);
      const slide = item.closest('.slide');
      const zones = [].slice.call(slide.querySelectorAll('[data-drop]'));
      if (!zones.length) return;
      const zone = zones.filter((z) => {
        const r = z.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      })[0];
      if (!zone) return;
      const accepts = zone.getAttribute('data-drop').split(/\s+/);
      if (accepts.indexOf(item.getAttribute('data-drag')) >= 0 || accepts.indexOf('*') >= 0) {
        item.classList.add('cw-right');
      } else {
        item.classList.add('cw-wrong');
        setTimeout(() => {
          item.style.transition = 'transform 0.4s';
          item.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
          setTimeout(() => {
            item.style.transition = '';
            item.classList.remove('cw-wrong');
          }, 450);
        }, 500);
      }
    }

    item.addEventListener('pointermove', move);
    item.addEventListener('pointerup', up);
    item.addEventListener('pointercancel', up);
  });

  /* ---------- Swipe to turn pages ---------- */

  let swipe = null;
  stage.addEventListener('pointerdown', (event) => {
    if (ink.active || event.pointerType === 'mouse') return;
    if (event.target.closest('.cw-tool, [data-drag], .choices, button, input, textarea, .cw-overlay')) return;
    swipe = { x: event.clientX, y: event.clientY };
  });
  window.addEventListener('pointerup', (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) next();
      else prev();
    }
  });

  /* ---------- Pen ---------- */

  const ink = (() => {
    const canvas = el('canvas', { id: 'cw-ink', width: W, height: H });
    stage.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const strokes = {};
    let current = 0;
    let color = '#d2463c';
    let drawing = null;

    function draw(stroke) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      stroke.points.forEach((p, i) => {
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y);
      ctx.stroke();
    }

    function redraw() {
      ctx.clearRect(0, 0, W, H);
      (strokes[current] || []).forEach(draw);
    }

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      drawing = { color: color, width: color === 'erase' ? 0 : 7, points: [stagePoint(event)] };
      if (color === 'erase') return;
      if (!strokes[current]) strokes[current] = [];
      strokes[current].push(drawing);
      draw(drawing);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drawing) return;
      const p = stagePoint(event);
      if (color === 'erase') {
        strokes[current] = (strokes[current] || []).filter(
          (stroke) => !stroke.points.some((q) => Math.abs(q.x - p.x) < 30 && Math.abs(q.y - p.y) < 30),
        );
        redraw();
        return;
      }
      drawing.points.push(p);
      redraw();
    });
    ['pointerup', 'pointercancel'].forEach((type) => {
      canvas.addEventListener(type, () => {
        drawing = null;
      });
    });

    return {
      active: false,
      setActive: function (on) {
        this.active = on;
        canvas.classList.toggle('cw-on', on);
      },
      setColor: (c) => {
        color = c;
      },
      show: (i) => {
        current = i;
        redraw();
      },
      clear: () => {
        strokes[current] = [];
        redraw();
      },
    };
  })();

  /* ---------- Overlays ---------- */

  function overlay(content) {
    const close = el('button', { class: 'cw-close', text: '×', 'aria-label': '关闭' });
    const panel = el('div', { class: 'cw-panel' }, [close].concat(content));
    const layer = el('div', { class: 'cw-overlay' }, [panel]);
    close.addEventListener('click', () => {
      layer.classList.remove('cw-on');
    });
    layer.addEventListener('pointerdown', (event) => {
      if (event.target === layer) layer.classList.remove('cw-on');
    });
    stage.appendChild(layer);
    return layer;
  }

  function closeOverlays() {
    const open = stage.querySelectorAll('.cw-overlay.cw-on');
    [].slice.call(open).forEach((layer) => {
      layer.classList.remove('cw-on');
    });
    return open.length > 0;
  }

  /* ---------- Timer ---------- */

  const timer = (() => {
    let total = 180;
    let left = total;
    let running = false;
    let last = 0;
    const display = el('div', { class: 'cw-timer-display' });
    const startBtn = el('button', { class: 'cw-btn primary', text: '开始' });
    const presets = el(
      'div',
      { class: 'cw-controls' },
      [30, 60, 120, 180, 300, 600].map((s) =>
        el('button', {
          class: 'cw-btn',
          text: s < 60 ? `${s} 秒` : `${s / 60} 分`,
          onclick: () => {
            set(s);
          },
        }),
      ),
    );
    const adjust = el('div', { class: 'cw-controls' }, [
      el('button', {
        class: 'cw-btn',
        text: '−10 秒',
        onclick: () => {
          set(Math.max(10, left - 10), true);
        },
      }),
      startBtn,
      el('button', {
        class: 'cw-btn',
        text: '重置',
        onclick: () => {
          set(total);
        },
      }),
      el('button', {
        class: 'cw-btn',
        text: '+10 秒',
        onclick: () => {
          set(left + 10, true);
        },
      }),
    ]);
    const layer = overlay([display, presets, adjust]);

    function format(s) {
      let m = Math.floor(s / 60);
      const r = Math.ceil(s % 60) % 60;
      if (Math.ceil(s % 60) === 60) m++;
      return `${m}:${r < 10 ? '0' : ''}${r}`;
    }

    function render() {
      display.textContent = format(Math.max(0, left));
      display.classList.toggle('cw-done', left <= 0);
      startBtn.textContent = running ? '暂停' : '开始';
      timerBtn.textContent = running || (left > 0 && left < total) ? format(Math.max(0, left)) : '计时';
      timerBtn.classList.toggle('cw-on', running);
    }

    function set(s, keepRunning) {
      if (!keepRunning) {
        total = s;
        running = false;
      }
      left = s;
      render();
    }

    function beep() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const audio = new Ctx();
        [0, 0.35, 0.7].forEach((t) => {
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.frequency.value = 880;
          gain.gain.setValueAtTime(0.3, audio.currentTime + t);
          gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + t + 0.3);
          osc.connect(gain).connect(audio.destination);
          osc.start(audio.currentTime + t);
          osc.stop(audio.currentTime + t + 0.3);
        });
      } catch (e) {
        // No audio on this machine; the flashing display is enough.
      }
    }

    function tick(now) {
      if (!running) return;
      left -= (now - last) / 1000;
      last = now;
      if (left <= 0) {
        left = 0;
        running = false;
        beep();
        layer.classList.add('cw-on');
      }
      render();
      if (running) requestAnimationFrame(tick);
    }

    startBtn.addEventListener('click', () => {
      if (left <= 0) left = total;
      running = !running;
      if (running) {
        last = performance.now();
        requestAnimationFrame(tick);
      }
      render();
    });

    return {
      open: () => {
        layer.classList.add('cw-on');
        render();
      },
      render: render,
    };
  })();

  /* ---------- Random picker ---------- */

  const picker = (() => {
    const KEY = 'cw-picker-names';
    const name = el('div', { class: 'cw-picker-name', text: '?' });
    const info = el('div', { class: 'small muted' });
    let drawn = [];
    let rolling = false;
    const listInput = el('textarea', { placeholder: '粘贴名单，每行一个；留空则按学号抽' });
    const countInput = el('input', { type: 'number', min: '2', max: '99', value: '40' });
    const settings = el('div', { style: 'display:none;flex-direction:column;align-items:center;gap:20px' }, [
      listInput,
      el('div', { class: 'row small' }, [el('span', { text: '没有名单时的人数' }), countInput]),
    ]);
    const drawBtn = el('button', { class: 'cw-btn primary', text: '抽一个' });
    const layer = overlay([
      name,
      info,
      el('div', { class: 'cw-controls' }, [
        drawBtn,
        el('button', {
          class: 'cw-btn',
          text: '重新开始',
          onclick: () => {
            drawn = [];
            name.textContent = '?';
            renderInfo();
          },
        }),
        el('button', {
          class: 'cw-btn',
          text: '名单',
          onclick: () => {
            settings.style.display = settings.style.display === 'none' ? 'flex' : 'none';
          },
        }),
      ]),
      settings,
    ]);

    try {
      listInput.value = localStorage.getItem(KEY) || '';
    } catch (e) {
      // Storage may be disabled for file:// pages; the list then lasts until the page closes.
    }
    listInput.addEventListener('input', () => {
      drawn = [];
      try {
        localStorage.setItem(KEY, listInput.value);
      } catch (e) {
        // See above.
      }
      renderInfo();
    });
    countInput.addEventListener('input', () => {
      drawn = [];
      renderInfo();
    });

    function pool() {
      const names = listInput.value
        .split(/[\n,，、]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length) return names;
      const n = Math.max(2, Math.min(99, parseInt(countInput.value, 10) || 40));
      const numbers = [];
      for (let i = 1; i <= n; i++) numbers.push(`${i} 号`);
      return numbers;
    }

    function renderInfo() {
      const all = pool();
      info.textContent = `已抽 ${drawn.length} / ${all.length}，不重复`;
    }

    drawBtn.addEventListener('click', () => {
      if (rolling) return;
      const all = pool();
      let left = all.filter((n) => drawn.indexOf(n) < 0);
      if (!left.length) {
        drawn = [];
        left = all;
      }
      const pick = left[Math.floor(Math.random() * left.length)];
      rolling = true;
      let count = 0;
      const spin = setInterval(() => {
        name.textContent = all[Math.floor(Math.random() * all.length)];
        if (++count >= 18) {
          clearInterval(spin);
          name.textContent = pick;
          drawn.push(pick);
          rolling = false;
          renderInfo();
        }
      }, 70);
    });

    return {
      open: () => {
        renderInfo();
        layer.classList.add('cw-on');
      },
    };
  })();

  /* ---------- Toolbar ---------- */

  const blackout = el('div', { id: 'cw-blackout' });
  document.body.appendChild(blackout);
  blackout.addEventListener('click', () => {
    blackout.classList.remove('cw-on');
  });

  const pageLabel = el('span', { class: 'cw-page' });
  const penBtn = el('button', { text: '画笔', title: '画笔 (P)' });
  const timerBtn = el('button', { text: '计时', title: '计时器 (T)' });
  const swatches = ['#d2463c', '#2f6fb3', '#2e9d62', '#23303b', 'erase'].map((c, i) => {
    const b = el('button', {
      class: `cw-swatch${i === 0 ? ' cw-on' : ''}`,
      title: c === 'erase' ? '橡皮' : '颜色',
      text: c === 'erase' ? '⌫' : '',
    });
    if (c !== 'erase') b.style.background = c;
    else b.style.background = '#fff';
    if (c === 'erase') b.style.color = '#23303b';
    b.addEventListener('click', () => {
      ink.setColor(c);
      swatches.forEach((s) => {
        s.classList.toggle('cw-on', s === b);
      });
    });
    return b;
  });
  const toolbar = el('div', { id: 'cw-toolbar' }, [
    el('button', { text: '‹', title: '上一步', onclick: prev }),
    pageLabel,
    el('button', { text: '›', title: '下一步', onclick: next }),
    penBtn,
    el(
      'span',
      { class: 'cw-pen-colors' },
      swatches.concat([
        el('button', {
          text: '清除',
          onclick: () => {
            ink.clear();
          },
        }),
      ]),
    ),
    timerBtn,
    el('button', {
      text: '点名',
      title: '随机点名 (R)',
      onclick: () => {
        picker.open();
      },
    }),
    el('button', { text: '重置', title: '重置本页', onclick: resetSlide }),
    el('button', { text: '全屏', title: '全屏 (F)', onclick: toggleFullscreen }),
  ]);
  if (params.get('toolbar') !== '0') document.body.appendChild(toolbar);

  function setPen(on) {
    ink.setActive(on);
    penBtn.classList.toggle('cw-on', on);
    toolbar.classList.toggle('cw-pen', on);
    toolbar.classList.toggle('cw-active', on);
  }
  penBtn.addEventListener('click', () => {
    setPen(!ink.active);
  });
  timerBtn.addEventListener('click', () => {
    timer.open();
  });

  /* ---------- Keyboard and clickers ---------- */

  document.addEventListener('keydown', (event) => {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (blackout.classList.contains('cw-on')) {
      blackout.classList.remove('cw-on');
      event.preventDefault();
      return;
    }
    const key = event.key;
    let handled = true;
    if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' ' || key === 'Enter') next();
    else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace') prev();
    else if (key === 'Home') go(0);
    else if (key === 'End') go(slides.length - 1);
    else if (key === 'F5' || key === 'f' || key === 'F') toggleFullscreen();
    else if (key === 'b' || key === 'B' || key === '.' || key === 'w' || key === 'W') blackout.classList.add('cw-on');
    else if (key === 'p' || key === 'P') setPen(!ink.active);
    else if (key === 't' || key === 'T') timer.open();
    else if (key === 'r' || key === 'R') picker.open();
    else if (key === 'Escape') {
      if (!closeOverlays() && ink.active) setPen(false);
      handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
  });

  /* ---------- Start ---------- */

  window.addEventListener('resize', fit);
  fit();
  slides.forEach((slide) => {
    slide.classList.remove('cw-current');
  });
  slides[0].classList.add('cw-current');
  const start = parseInt(location.hash.slice(1), 10);
  go(Number.isNaN(start) ? 0 : start - 1);
  timer.render();

  window.courseware = { next: next, prev: prev, go: go, reset: resetSlide };
})();
