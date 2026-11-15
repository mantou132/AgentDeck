/*
 * Math manipulatives as custom elements. Load before courseware.js. Each element reads its attributes once,
 * draws with SVG and implements cwReset(), which the toolbar's 重置 button calls.
 */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
  const COLOR_NAMES = {
    红: '#e0524a',
    黄: '#f2c230',
    蓝: '#4c8fd6',
    绿: '#52b07c',
    紫: '#9a6fd0',
    橙: '#ef8a3c',
    白: '#ffffff',
    黑: '#333333',
    粉: '#f08db0',
  };

  function svg(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach((key) => {
      if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    if (parent) parent.appendChild(node);
    return node;
  }

  function html(tag, attrs, parent) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach((key) => {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'html') node.innerHTML = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    if (parent) parent.appendChild(node);
    return node;
  }

  function button(text, onClick, parent, cls) {
    const b = html('button', { class: `cw-btn${cls ? ` ${cls}` : ''}`, text: text }, parent);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  /** Pointer position in the SVG's own units, whatever the stage scale. */
  function svgPoint(root, event) {
    const p = root.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    return p.matrixTransform(root.getScreenCTM().inverse());
  }

  /** Calls onMove(point) while a pointer drags `handle`. */
  function draggable(root, handle, onMove, onEnd) {
    handle.style.cursor = 'grab';
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      function move(e) {
        onMove(svgPoint(root, e));
      }
      function up() {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (onEnd) onEnd();
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function num(el, name, fallback) {
    const v = parseFloat(el.getAttribute(name));
    return Number.isNaN(v) ? fallback : v;
  }

  function list(el, name) {
    const v = el.getAttribute(name);
    return v
      ? v
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  function fmt(n) {
    return String(Math.round(n * 1000) / 1000);
  }

  /** Like fmt() with a proper minus sign (−3, not -3), for numbers shown to students. */
  function signed(n) {
    return fmt(n).replace('-', '−');
  }

  function gcd(a, b) {
    return b ? gcd(b, a % b) : Math.abs(a);
  }

  function fracHtml(n, d) {
    return `<span class="frac"><span>${n}</span><span>${d}</span></span>`;
  }

  /** Draws a stacked fraction n/d centred at (x, y) inside an SVG group. */
  function svgFrac(parent, x, y, n, d, size, color) {
    const g = svg('g', { fill: color || 'currentColor' }, parent);
    svg('text', { x: x, y: y - size * 0.15, 'text-anchor': 'middle', 'font-size': size, text: n }, g);
    svg(
      'line',
      { x1: x - size * 0.45, x2: x + size * 0.45, y1: y, y2: y, stroke: color || 'currentColor', 'stroke-width': 3 },
      g,
    );
    svg('text', { x: x, y: y + size * 0.85, 'text-anchor': 'middle', 'font-size': size, text: d }, g);
    return g;
  }

  /** Base class: builds once when connected, rebuilds on cwReset(). */
  function define(name, build) {
    if (customElements.get(name)) return;
    customElements.define(
      name,
      class extends HTMLElement {
        connectedCallback() {
          if (this._built) return;
          this._built = true;
          this.classList.add('cw-tool');
          this._source = this.innerHTML;
          build.call(this);
        }
        cwReset() {
          this.innerHTML = this._source;
          build.call(this);
        }
      },
    );
  }

  /* ---------- <cw-number-line min="0" max="10" step="1" points="3" hops fractions="4" opposite abs> ---------- */

  define('cw-number-line', function () {
    const self = this;
    const min = num(this, 'min', 0);
    const max = num(this, 'max', 10);
    const denominator = num(this, 'fractions', 0);
    const step = denominator ? 1 / denominator : num(this, 'step', 1);
    const snap = num(this, 'snap', step);
    const labelEvery = num(this, 'label-every', denominator ? step : (max - min) / step > 20 ? step * 5 : step);
    const width = num(this, 'width', 1500);
    const hops = this.hasAttribute('hops');
    const opposite = this.hasAttribute('opposite');
    const absolute = this.hasAttribute('abs');
    const values = list(this, 'points').map((v) => parseFloat(v.replace('−', '-')));
    const pad = 60;
    const span = width - pad * 2;
    const y = 150;

    const root = svg('svg', {
      width: width,
      height: denominator ? 280 : 240,
      viewBox: `0 0 ${width} ${denominator ? 280 : 240}`,
    });
    this.appendChild(root);
    const readout = html('div', { class: 'cw-readout' }, this);

    function xOf(v) {
      return pad + ((v - min) / (max - min)) * span;
    }
    function vOf(x) {
      let v = min + ((x - pad) / span) * (max - min);
      v = Math.round(v / snap) * snap;
      return Math.max(min, Math.min(max, Math.round(v * 1e6) / 1e6));
    }

    svg('line', { x1: pad - 30, x2: width - pad + 30, y1: y, y2: y, stroke: 'var(--ink)', 'stroke-width': 5 }, root);
    svg('path', { d: `M${width - pad + 30} ${y - 14}l26 14l-26 14z`, fill: 'var(--ink)' }, root);
    const count = Math.round((max - min) / step);
    const labelTicks = Math.max(1, Math.round(labelEvery / step));
    for (let i = 0; i <= count; i++) {
      const v = min + i * step;
      const x = xOf(v);
      const labeled = i % labelTicks === 0;
      const whole = Math.abs(v - Math.round(v)) < 1e-6;
      svg(
        'line',
        {
          x1: x,
          x2: x,
          y1: y - (labeled ? 20 : 12),
          y2: y + (labeled ? 20 : 12),
          stroke: 'var(--ink)',
          'stroke-width': 4,
        },
        root,
      );
      if (!labeled) continue;
      if (denominator && !whole) {
        svgFrac(root, x, y + 62, Math.round(v * denominator), denominator, 34);
      } else {
        svg(
          'text',
          { x: x, y: y + 66, 'text-anchor': 'middle', 'font-size': 38, fill: 'var(--ink)', text: signed(v) },
          root,
        );
      }
    }

    const hopLayer = svg('g', {}, root);
    const markLayer = svg('g', {}, root);
    const handles = values.map((value, k) => {
      const g = svg('g', { class: 'cw-handle' }, root);
      svg('circle', { r: 30, fill: 'transparent' }, g);
      svg('circle', { r: 18, fill: PALETTE[k % PALETTE.length], stroke: '#fff', 'stroke-width': 5 }, g);
      const point = { value: value, g: g };
      draggable(root, g, (p) => {
        point.value = vOf(p.x);
        render();
      });
      return point;
    });

    function label(v) {
      if (!denominator) return signed(v);
      const n = Math.round(v * denominator);
      if (n % denominator === 0) return signed(n / denominator);
      const g = gcd(n, denominator);
      const sign = n < 0 ? '−' : '';
      const a = Math.abs(n);
      return `${sign}${fracHtml(a, denominator)}${g > 1 ? ` = ${sign}${fracHtml(a / g, denominator / g)}` : ''}`;
    }

    /** Opposite numbers as hollow points, absolute values as a bar from 0 above the line. */
    function drawMarks() {
      while (markLayer.firstChild) markLayer.removeChild(markLayer.firstChild);
      handles.forEach((h, k) => {
        const color = PALETTE[k % PALETTE.length];
        if (opposite && h.value !== 0 && -h.value >= min && -h.value <= max) {
          svg(
            'circle',
            { cx: xOf(-h.value), cy: y, r: 16, fill: 'var(--paper)', stroke: color, 'stroke-width': 5 },
            markLayer,
          );
          svg(
            'line',
            {
              x1: xOf(0),
              x2: xOf(0),
              y1: y - 70,
              y2: y - 26,
              stroke: 'var(--muted)',
              'stroke-width': 3,
              'stroke-dasharray': '6 6',
            },
            markLayer,
          );
        }
        if (absolute && h.value !== 0 && 0 >= min && 0 <= max) {
          const lift = y - 46 - k * 34;
          const x1 = xOf(0);
          const x2 = xOf(h.value);
          svg('line', { x1: x1, x2: x2, y1: lift, y2: lift, stroke: color, 'stroke-width': 6 }, markLayer);
          svg('line', { x1: x1, x2: x1, y1: lift - 12, y2: lift + 12, stroke: color, 'stroke-width': 4 }, markLayer);
          svg('line', { x1: x2, x2: x2, y1: lift - 12, y2: lift + 12, stroke: color, 'stroke-width': 4 }, markLayer);
          svg(
            'text',
            {
              x: (x1 + x2) / 2,
              y: lift - 14,
              'text-anchor': 'middle',
              'font-size': 30,
              'font-weight': 700,
              fill: color,
              text: `距离 ${signed(Math.abs(h.value))}`,
            },
            markLayer,
          );
        }
      });
    }

    function describe(v) {
      let text = label(v);
      if (opposite) text += `<span class="small muted">的相反数是</span>${label(-v === 0 ? 0 : -v)}`;
      if (absolute) text += `<span class="small muted">绝对值</span>|${label(v)}| = ${label(Math.abs(v))}`;
      return text;
    }

    function render() {
      handles.forEach((h) => {
        h.g.setAttribute('transform', `translate(${xOf(h.value)},${y})`);
      });
      while (hopLayer.firstChild) hopLayer.removeChild(hopLayer.firstChild);
      if (hops && handles.length > 1) {
        for (let k = 1; k < handles.length; k++) {
          const a = handles[k - 1].value;
          const b = handles[k].value;
          if (a === b) continue;
          const x1 = xOf(a);
          const x2 = xOf(b);
          const lift = Math.min(90, Math.abs(x2 - x1) * 0.45 + 20);
          svg(
            'path',
            {
              d:
                'M' +
                x1 +
                ' ' +
                (y - 24) +
                ' Q' +
                (x1 + x2) / 2 +
                ' ' +
                (y - 24 - lift * 2) +
                ' ' +
                x2 +
                ' ' +
                (y - 24),
              fill: 'none',
              stroke: 'var(--accent)',
              'stroke-width': 5,
            },
            hopLayer,
          );
          const dir = b > a ? 1 : -1;
          svg('path', { d: `M${x2} ${y - 22}l${-dir * 22} -16l${dir * 4} 22z`, fill: 'var(--accent)' }, hopLayer);
          svg(
            'text',
            {
              x: (x1 + x2) / 2,
              y: y - 30 - lift,
              'text-anchor': 'middle',
              'font-size': 34,
              fill: 'var(--accent)',
              'font-weight': 700,
              text: (b > a ? '+' : '−') + fmt(Math.abs(b - a)),
            },
            hopLayer,
          );
        }
      }
      drawMarks();
      if (self.hasAttribute('hide-readout')) return;
      readout.innerHTML = handles
        .map((h, k) => `<span style="color:${PALETTE[k % PALETTE.length]}">●</span> ${describe(h.value)}`)
        .join('<span style="width:40px"></span>');
    }
    render();
  });

  /* ---------- <cw-fraction shape="circle|bar|grid" parts="4" shaded="1" controls> ---------- */

  define('cw-fraction', function () {
    const self = this;
    const shape = this.getAttribute('shape') || 'circle';
    let parts = num(this, 'parts', 4);
    const initial = num(this, 'shaded', 0);
    const color = this.getAttribute('color') || 'var(--c2)';
    const size = num(this, 'size', shape === 'bar' ? 900 : 420);
    const rows = num(this, 'rows', 0);
    let shaded = [];
    for (let s = 0; s < parts; s++) shaded.push(s < initial);

    const holder = html('div', {}, this);
    const readout = html('div', { class: 'cw-readout' }, this);
    if (this.hasAttribute('controls')) {
      const controls = html('div', { class: 'cw-controls' }, this);
      button(
        '− 份',
        () => {
          if (parts > 1) setParts(parts - 1);
        },
        controls,
      );
      button(
        '+ 份',
        () => {
          if (parts < 24) setParts(parts + 1);
        },
        controls,
      );
    }

    function setParts(n) {
      const count = shaded.filter(Boolean).length;
      parts = n;
      shaded = [];
      for (let i = 0; i < parts; i++) shaded.push(i < Math.min(count, parts));
      render();
    }

    function piece(node, i) {
      node.setAttribute('fill', shaded[i] ? color : 'var(--paper)');
      node.setAttribute('stroke', 'var(--ink)');
      node.setAttribute('stroke-width', 4);
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        shaded[i] = !shaded[i];
        render();
      });
    }

    function render() {
      holder.innerHTML = '';
      let root;
      if (shape === 'circle') {
        const r = size / 2 - 6;
        root = svg('svg', { width: size, height: size, viewBox: `${-size / 2} ${-size / 2} ${size} ${size}` }, holder);
        if (parts === 1) piece(svg('circle', { r: r }, root), 0);
        else
          for (let i = 0; i < parts; i++) {
            const a1 = (i / parts) * Math.PI * 2 - Math.PI / 2;
            const a2 = ((i + 1) / parts) * Math.PI * 2 - Math.PI / 2;
            const large = a2 - a1 > Math.PI ? 1 : 0;
            piece(
              svg(
                'path',
                {
                  d:
                    'M0 0L' +
                    r * Math.cos(a1) +
                    ' ' +
                    r * Math.sin(a1) +
                    'A' +
                    r +
                    ' ' +
                    r +
                    ' 0 ' +
                    large +
                    ' 1 ' +
                    r * Math.cos(a2) +
                    ' ' +
                    r * Math.sin(a2) +
                    'Z',
                },
                root,
              ),
              i,
            );
          }
      } else if (shape === 'bar') {
        const h = 140;
        root = svg('svg', { width: size, height: h + 8, viewBox: `-4 -4 ${size + 8} ${h + 8}` }, holder);
        for (let j = 0; j < parts; j++)
          piece(svg('rect', { x: (j * size) / parts, y: 0, width: size / parts, height: h }, root), j);
      } else {
        let rowCount = rows || Math.max(1, Math.round(Math.sqrt(parts)));
        while (parts % rowCount) rowCount--;
        const colCount = parts / rowCount;
        const cell = Math.min(size / colCount, size / rowCount);
        root = svg(
          'svg',
          {
            width: cell * colCount + 8,
            height: cell * rowCount + 8,
            viewBox: `-4 -4 ${cell * colCount + 8} ${cell * rowCount + 8}`,
          },
          holder,
        );
        for (let k = 0; k < parts; k++)
          piece(
            svg(
              'rect',
              { x: (k % colCount) * cell, y: Math.floor(k / colCount) * cell, width: cell, height: cell },
              root,
            ),
            k,
          );
      }
      if (self.hasAttribute('hide-readout')) return;
      const n = shaded.filter(Boolean).length;
      readout.innerHTML = n ? fracHtml(n, parts) : '<span class="muted small">点一点涂色</span>';
    }
    render();
  });

  /* ---------- <cw-clock time="3:00" size="560" hide-readout> ---------- */

  define('cw-clock', function () {
    const self = this;
    const parts = (this.getAttribute('time') || '3:00').split(':');
    let minutes = (parseInt(parts[0], 10) % 12) * 60 + (parseInt(parts[1], 10) || 0);
    const size = num(this, 'size', 560);
    const step = num(this, 'snap', 1);
    const r = size / 2 - 10;
    let showReadout = !this.hasAttribute('hide-readout');

    const root = svg('svg', {
      width: size,
      height: size,
      viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`,
    });
    this.appendChild(root);
    const readout = html('div', { class: 'cw-readout' }, this);
    const controls = html('div', { class: 'cw-controls' }, this);
    const toggle = button(
      showReadout ? '隐藏时间' : '显示时间',
      () => {
        showReadout = !showReadout;
        toggle.textContent = showReadout ? '隐藏时间' : '显示时间';
        render();
      },
      controls,
    );

    svg('circle', { r: r, fill: 'var(--paper)', stroke: 'var(--ink)', 'stroke-width': 8 }, root);
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const big = i % 5 === 0;
      const r1 = r - (big ? 34 : 18);
      svg(
        'line',
        {
          x1: Math.sin(a) * r1,
          y1: -Math.cos(a) * r1,
          x2: Math.sin(a) * (r - 8),
          y2: -Math.cos(a) * (r - 8),
          stroke: 'var(--ink)',
          'stroke-width': big ? 6 : 3,
        },
        root,
      );
      if (big) {
        const rn = r - 72;
        svg(
          'text',
          {
            x: Math.sin(a) * rn,
            y: -Math.cos(a) * rn + size * 0.03,
            'text-anchor': 'middle',
            'font-size': size * 0.085,
            'font-weight': 700,
            fill: 'var(--ink)',
            text: i / 5 || 12,
          },
          root,
        );
      }
    }
    const hourHand = svg('g', { class: 'cw-handle' }, root);
    svg(
      'line',
      { x1: 0, y1: r * 0.12, x2: 0, y2: -r * 0.5, stroke: 'var(--c4)', 'stroke-width': 18, 'stroke-linecap': 'round' },
      hourHand,
    );
    svg('line', { x1: 0, y1: 0, x2: 0, y2: -r * 0.55, stroke: 'transparent', 'stroke-width': 60 }, hourHand);
    const minuteHand = svg('g', { class: 'cw-handle' }, root);
    svg(
      'line',
      { x1: 0, y1: r * 0.14, x2: 0, y2: -r * 0.78, stroke: 'var(--c1)', 'stroke-width': 10, 'stroke-linecap': 'round' },
      minuteHand,
    );
    svg('line', { x1: 0, y1: -r * 0.3, x2: 0, y2: -r * 0.8, stroke: 'transparent', 'stroke-width': 60 }, minuteHand);
    svg('circle', { r: 16, fill: 'var(--ink)' }, root);

    function angleOf(p) {
      const deg = (Math.atan2(p.x, -p.y) * 180) / Math.PI;
      return (deg + 360) % 360;
    }

    draggable(root, minuteHand, (p) => {
      const m = (Math.round(angleOf(p) / 6 / step) * step) % 60;
      const current = ((minutes % 60) + 60) % 60;
      let diff = m - current;
      if (diff > 30) diff -= 60;
      if (diff < -30) diff += 60;
      minutes = (minutes + diff + 720) % 720;
      render();
    });
    draggable(root, hourHand, (p) => {
      const h = Math.floor(angleOf(p) / 30);
      minutes = h * 60 + (minutes % 60);
      render();
    });

    function render() {
      hourHand.setAttribute('transform', `rotate(${minutes * 0.5})`);
      minuteHand.setAttribute('transform', `rotate(${(minutes % 60) * 6})`);
      const h = Math.floor(minutes / 60) || 12;
      const m = minutes % 60;
      readout.textContent = showReadout ? `${h}:${m < 10 ? '0' : ''}${m}` : '?';
      self.setAttribute('data-time', `${h}:${m < 10 ? '0' : ''}${m}`);
    }
    render();
  });

  /* ---------- <cw-geoboard cols="12" rows="7" points="1,1 6,1 6,4" show="area perimeter lengths angles" unit="cm"> ---------- */

  define('cw-geoboard', function () {
    const self = this;
    const cols = num(this, 'cols', 12);
    const rows = num(this, 'rows', 7);
    const cell = num(this, 'cell', Math.min(1400 / cols, 620 / rows));
    const show = (this.getAttribute('show') || 'area').split(/\s+/);
    const unit = this.getAttribute('unit') || '';
    const color = this.getAttribute('color') || 'var(--c1)';
    const pts = (this.getAttribute('points') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => {
        const xy = s.split(',');
        return { x: parseFloat(xy[0]), y: parseFloat(xy[1]) };
      });
    const cellsMode = !pts.length;
    const filled = {};
    const pad = 30;
    const w = cols * cell + pad * 2;
    const h = rows * cell + pad * 2;

    const root = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    this.appendChild(root);
    const readout = html('div', { class: 'cw-readout small' }, this);
    const gridLayer = svg('g', {}, root);
    const shapeLayer = svg('g', {}, root);
    const labelLayer = svg('g', {}, root);

    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const rect = svg(
          'rect',
          {
            x: pad + cx * cell,
            y: pad + cy * cell,
            width: cell,
            height: cell,
            fill: 'var(--paper)',
            stroke: 'var(--line)',
            'stroke-width': 2,
          },
          gridLayer,
        );
        if (cellsMode) {
          rect.style.cursor = 'pointer';
          ((key, node) => {
            node.addEventListener('click', (e) => {
              e.stopPropagation();
              filled[key] = !filled[key];
              node.setAttribute('fill', filled[key] ? color : 'var(--paper)');
              render();
            });
          })(`${cx},${cy}`, rect);
        }
      }
    }

    function X(p) {
      return pad + p.x * cell;
    }
    function Y(p) {
      return pad + p.y * cell;
    }
    function u(v) {
      return fmt(v) + (unit ? ` ${unit}` : '');
    }

    const polygon = svg(
      'polygon',
      { fill: color, 'fill-opacity': 0.25, stroke: color, 'stroke-width': 6, 'stroke-linejoin': 'round' },
      shapeLayer,
    );
    const handles = pts.map((p) => {
      const g = svg('g', { class: 'cw-handle' }, shapeLayer);
      svg('circle', { r: 34, fill: 'transparent' }, g);
      svg('circle', { r: 14, fill: color, stroke: '#fff', 'stroke-width': 4 }, g);
      draggable(root, g, (q) => {
        p.x = Math.max(0, Math.min(cols, Math.round((q.x - pad) / cell)));
        p.y = Math.max(0, Math.min(rows, Math.round((q.y - pad) / cell)));
        render();
      });
      return g;
    });

    function render() {
      if (cellsMode) {
        const n = Object.keys(filled).filter((k) => filled[k]).length;
        readout.textContent = `涂了 ${n} 个方格${unit ? `，面积 ${n} ${unit}²` : ''}`;
        return;
      }
      polygon.setAttribute('points', pts.map((p) => `${X(p)},${Y(p)}`).join(' '));
      handles.forEach((g, i) => {
        g.setAttribute('transform', `translate(${X(pts[i])},${Y(pts[i])})`);
      });
      while (labelLayer.firstChild) labelLayer.removeChild(labelLayer.firstChild);
      let area = 0;
      let perimeter = 0;
      let straight = true;
      let cxSum = 0;
      let cySum = 0;
      pts.forEach((p) => {
        cxSum += p.x / pts.length;
        cySum += p.y / pts.length;
      });
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        area += p.x * q.y - q.x * p.y;
        const len = Math.sqrt((q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y));
        perimeter += len;
        const axis = p.x === q.x || p.y === q.y;
        if (!axis) straight = false;
        if (show.indexOf('lengths') >= 0 && axis && len > 0 && pts.length > 2) {
          const mx = (p.x + q.x) / 2;
          const my = (p.y + q.y) / 2;
          const vertical = p.x === q.x;
          // Outside the shape: beside a vertical side, above or below a horizontal one.
          const out = vertical ? (mx < cxSum ? -1 : 1) : my < cySum ? -1 : 1;
          svg(
            'text',
            {
              x: X({ x: mx }) + (vertical ? out * 14 : 0),
              y: Y({ y: my }) + (vertical ? 12 : out * 22 + (out > 0 ? 26 : 0)),
              'text-anchor': vertical ? (out < 0 ? 'end' : 'start') : 'middle',
              'font-size': 34,
              'font-weight': 700,
              fill: 'var(--ink)',
              text: u(len),
            },
            labelLayer,
          );
        }
        if (show.indexOf('angles') >= 0 && pts.length > 2) {
          const o = pts[(i - 1 + pts.length) % pts.length];
          const a1 = Math.atan2(o.y - p.y, o.x - p.x);
          const a2 = Math.atan2(q.y - p.y, q.x - p.x);
          let deg = Math.abs(((a2 - a1) * 180) / Math.PI);
          if (deg > 180) deg = 360 - deg;
          const bx = p.x - cxSum;
          const by = p.y - cySum;
          const bd = Math.sqrt(bx * bx + by * by) || 1;
          svg(
            'text',
            {
              x: X({ x: p.x - (bx / bd) * 0.75 }),
              y: Y({ y: p.y - (by / bd) * 0.75 }) + 12,
              'text-anchor': 'middle',
              'font-size': 30,
              fill: 'var(--accent)',
              'font-weight': 700,
              text: `${Math.round(deg)}°`,
            },
            labelLayer,
          );
        }
      });
      area = Math.abs(area) / 2;
      const parts = [];
      if (show.indexOf('area') >= 0) parts.push(`面积 ${fmt(area)}${unit ? ` ${unit}²` : ' 个方格'}`);
      if (show.indexOf('perimeter') >= 0 && straight) parts.push(`周长 ${u(perimeter)}`);
      readout.textContent = parts.join('　');
      self.setAttribute('data-area', fmt(area));
    }
    render();
  });

  /* ---------- <cw-counter places="4" value="0"> 计数器 ---------- */

  define('cw-counter', function () {
    const NAMES = ['个位', '十位', '百位', '千位', '万位', '十万位', '百万位'];
    const places = num(this, 'places', 4);
    const value = num(this, 'value', 0);
    const beads = [];
    for (let i = 0; i < places; i++) {
      beads.push(Math.floor(value / 10 ** i) % 10);
    }
    const rodGap = 170;
    const w = places * rodGap + 40;
    const h = 560;
    const bead = 38;

    const root = svg('svg', { width: w, height: h + 70, viewBox: `0 0 ${w} ${h + 70}` });
    this.appendChild(root);
    const readout = html('div', { class: 'cw-readout' }, this);
    const controls = html('div', { class: 'cw-controls' }, this);
    const carryBtn = button(
      '满十进一',
      () => {
        for (let k = 0; k < places - 1; k++) {
          if (beads[k] >= 10) {
            beads[k] -= 10;
            beads[k + 1]++;
            break;
          }
        }
        render();
      },
      controls,
      'primary',
    );
    const layer = svg('g', {}, root);

    function render() {
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      svg('rect', { x: 10, y: h - 30, width: w - 20, height: 30, rx: 10, fill: '#9b7653' }, layer);
      let total = 0;
      for (let k = 0; k < places; k++) {
        const x = w - 20 - rodGap / 2 - k * rodGap;
        total += beads[k] * 10 ** k;
        svg('line', { x1: x, x2: x, y1: 40, y2: h - 30, stroke: '#7a6450', 'stroke-width': 8 }, layer);
        const full = beads[k] >= 10;
        for (let b = 0; b < beads[k]; b++) {
          svg(
            'ellipse',
            {
              cx: x,
              cy: h - 30 - bead / 2 - b * bead - 2,
              rx: 56,
              ry: bead / 2 - 1,
              fill: full ? 'var(--accent)' : PALETTE[k % PALETTE.length],
              stroke: 'rgba(0,0,0,.25)',
              'stroke-width': 2,
            },
            layer,
          );
        }
        svg(
          'text',
          { x: x, y: h + 50, 'text-anchor': 'middle', 'font-size': 32, fill: 'var(--ink)', text: NAMES[k] },
          layer,
        );
        ((place, cx) => {
          const hit = svg(
            'rect',
            { x: cx - rodGap / 2 + 6, y: 20, width: rodGap - 12, height: h - 50, fill: 'transparent' },
            layer,
          );
          hit.style.cursor = 'pointer';
          hit.addEventListener('click', (e) => {
            e.stopPropagation();
            const p = svgPoint(root, e);
            const top = h - 30 - beads[place] * bead;
            if (p.y < top - 10 && beads[place] < (place === places - 1 ? 9 : 10)) beads[place]++;
            else if (beads[place] > 0) beads[place]--;
            render();
          });
        })(k, x);
      }
      const needCarry = beads.some((n) => n >= 10);
      carryBtn.style.visibility = needCarry ? 'visible' : 'hidden';
      readout.innerHTML = needCarry ? '<span class="accent-text">满十了，要进一</span>' : String(total);
    }
    render();
  });

  /* ---------- <cw-bar-chart items="苹果,香蕉,橘子" values="0,0,0" tally> ---------- */

  define('cw-bar-chart', function () {
    const items = list(this, 'items');
    const values = list(this, 'values').map(Number);
    const counts = items.map((_, i) => values[i] || 0);
    const tally = this.hasAttribute('tally');
    const unitLabel = this.getAttribute('unit') || '';
    const barW = Math.min(180, 1300 / items.length - 40);
    const gap = barW * 0.5;
    const w = items.length * (barW + gap) + 120;
    const h = 560;
    const base = h - 60;

    const root = svg('svg', {
      width: w,
      height: h + (tally ? 90 : 0),
      viewBox: `0 0 ${w} ${h + (tally ? 90 : 0)}`,
    });
    this.appendChild(root);
    const layer = svg('g', {}, root);

    function tallyMarks(parent, x, y, n) {
      const groups = Math.ceil(n / 5);
      const size = 44;
      for (let g = 0; g < groups; g++) {
        const strokes = Math.min(5, n - g * 5);
        const ox = x - (groups * (size + 12)) / 2 + g * (size + 12);
        const lines = [
          [0, 0, size, 0],
          [size / 2, 0, size / 2, size],
          [size / 2, size / 2, size * 0.9, size / 2],
          [size * 0.15, size * 0.45, size * 0.15, size],
          [0, size, size, size],
        ];
        for (let s = 0; s < strokes; s++) {
          const l = lines[s];
          svg(
            'line',
            {
              x1: ox + l[0],
              y1: y + l[1],
              x2: ox + l[2],
              y2: y + l[3],
              stroke: 'var(--ink)',
              'stroke-width': 5,
              'stroke-linecap': 'round',
            },
            parent,
          );
        }
      }
    }

    function render() {
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      const max = Math.max(5, Math.max.apply(null, counts));
      const scaleY = (base - 60) / max;
      const tick = max <= 10 ? 1 : max <= 20 ? 2 : 5;
      for (let t = 0; t <= max; t += tick) {
        const ty = base - t * scaleY;
        svg('line', { x1: 80, x2: w - 10, y1: ty, y2: ty, stroke: 'var(--line)', 'stroke-width': 2 }, layer);
        svg('text', { x: 66, y: ty + 10, 'text-anchor': 'end', 'font-size': 28, fill: 'var(--muted)', text: t }, layer);
      }
      svg('line', { x1: 80, x2: 80, y1: 20, y2: base, stroke: 'var(--ink)', 'stroke-width': 4 }, layer);
      svg('line', { x1: 80, x2: w - 10, y1: base, y2: base, stroke: 'var(--ink)', 'stroke-width': 4 }, layer);
      if (unitLabel)
        svg(
          'text',
          { x: 80, y: 14, 'text-anchor': 'middle', 'font-size': 26, fill: 'var(--muted)', text: unitLabel },
          layer,
        );
      items.forEach((name, i) => {
        const x = 80 + gap / 2 + 20 + i * (barW + gap);
        const bh = counts[i] * scaleY;
        svg('rect', { x: x, y: base - bh, width: barW, height: bh, rx: 8, fill: PALETTE[i % PALETTE.length] }, layer);
        if (counts[i])
          svg(
            'text',
            {
              x: x + barW / 2,
              y: base - bh - 14,
              'text-anchor': 'middle',
              'font-size': 36,
              'font-weight': 700,
              fill: 'var(--ink)',
              text: counts[i],
            },
            layer,
          );
        svg(
          'text',
          { x: x + barW / 2, y: base + 44, 'text-anchor': 'middle', 'font-size': 34, fill: 'var(--ink)', text: name },
          layer,
        );
        if (tally) tallyMarks(layer, x + barW / 2, base + 70, counts[i]);
        const hit = svg(
          'rect',
          { x: x - gap / 2, y: 20, width: barW + gap, height: base - 20, fill: 'transparent' },
          layer,
        );
        hit.style.cursor = 'pointer';
        hit.addEventListener('click', (e) => {
          e.stopPropagation();
          counts[i]++;
          added.push(i);
          render();
        });
      });
    }
    const added = [];
    const controls = html('div', { class: 'cw-controls' }, this);
    html('span', { class: 'small muted', text: '点柱子加一' }, controls);
    button(
      '撤销',
      () => {
        if (!added.length) return;
        counts[added.pop()]--;
        render();
      },
      controls,
    );
    render();
  });

  /* ---------- <cw-spinner sectors="红,红,黄,蓝"> ---------- */

  define('cw-spinner', function () {
    let sectors = list(this, 'sectors');
    if (!sectors.length) sectors = ['红', '黄', '蓝'];
    const size = num(this, 'size', 480);
    const r = size / 2 - 10;
    let angle = 0;
    let spinning = false;
    const labels = [];
    sectors.forEach((s) => {
      if (labels.indexOf(s) < 0) labels.push(s);
    });
    const results = labels.map(() => 0);

    const wrap = html('div', { class: 'row', style: 'gap:60px;align-items:center' }, this);
    const left = html('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:24px' }, wrap);
    const root = svg(
      'svg',
      { width: size, height: size + 30, viewBox: `${-size / 2} ${-size / 2 - 30} ${size} ${size + 30}` },
      left,
    );
    const wheel = svg('g', {}, root);
    sectors.forEach((name, i) => {
      const a1 = (i / sectors.length) * Math.PI * 2 - Math.PI / 2;
      const a2 = ((i + 1) / sectors.length) * Math.PI * 2 - Math.PI / 2;
      const fill = COLOR_NAMES[name[0]] || PALETTE[labels.indexOf(name) % PALETTE.length];
      const large = a2 - a1 > Math.PI ? 1 : 0;
      const d =
        sectors.length === 1
          ? null
          : 'M0 0L' +
            r * Math.cos(a1) +
            ' ' +
            r * Math.sin(a1) +
            'A' +
            r +
            ' ' +
            r +
            ' 0 ' +
            large +
            ' 1 ' +
            r * Math.cos(a2) +
            ' ' +
            r * Math.sin(a2) +
            'Z';
      if (d) svg('path', { d: d, fill: fill, stroke: '#fff', 'stroke-width': 5 }, wheel);
      else svg('circle', { r: r, fill: fill }, wheel);
      const mid = (a1 + a2) / 2;
      svg(
        'text',
        {
          x: r * 0.62 * Math.cos(mid),
          y: r * 0.62 * Math.sin(mid) + 14,
          'text-anchor': 'middle',
          'font-size': 40,
          'font-weight': 700,
          fill: name[0] === '白' || name[0] === '黄' ? '#333' : '#fff',
          text: name,
        },
        wheel,
      );
    });
    svg('circle', { r: r, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 6 }, root);
    svg('path', { d: `M-22 ${-r - 26}L22 ${-r - 26}L0 ${-r + 24}Z`, fill: 'var(--ink)' }, root);
    svg('circle', { r: 14, fill: 'var(--ink)' }, root);
    const result = html('div', { class: 'cw-readout' }, left);

    const table = html('table', { style: 'font-size:36px;border-collapse:collapse' }, wrap);
    function renderTable() {
      const total = results.reduce((a, b) => a + b, 0);
      table.innerHTML =
        '<tr><th style="padding:8px 24px;text-align:left">结果</th><th style="padding:8px 24px">次数</th></tr>' +
        labels
          .map(
            (name, i) =>
              '<tr><td style="padding:8px 24px">' +
              name +
              '</td><td style="padding:8px 24px;text-align:center;font-weight:700">' +
              results[i] +
              '</td></tr>',
          )
          .join('') +
        '<tr><td style="padding:8px 24px;color:var(--muted)">合计</td><td style="padding:8px 24px;text-align:center;color:var(--muted)">' +
        total +
        '</td></tr>';
    }

    const controls = html('div', { class: 'cw-controls' }, left);
    function spin(times) {
      if (spinning) return;
      if (times > 1) {
        for (let t = 0; t < times; t++) results[labels.indexOf(sectors[Math.floor(Math.random() * sectors.length)])]++;
        result.textContent = `又转了 ${times} 次`;
        renderTable();
        return;
      }
      spinning = true;
      const pick = Math.floor(Math.random() * sectors.length);
      const offset = (Math.random() * 0.7 + 0.15) / sectors.length;
      const target = 360 - (pick / sectors.length + offset) * 360;
      angle = angle - (angle % 360) + 360 * 5 + target;
      wheel.style.transition = 'transform 3s cubic-bezier(.17,.67,.2,1)';
      wheel.style.transform = `rotate(${angle}deg)`;
      result.textContent = '…';
      setTimeout(() => {
        spinning = false;
        results[labels.indexOf(sectors[pick])]++;
        result.textContent = sectors[pick];
        renderTable();
      }, 3100);
    }
    button(
      '转一次',
      () => {
        spin(1);
      },
      controls,
      'primary',
    );
    button(
      '快速转 10 次',
      () => {
        spin(10);
      },
      controls,
    );
    renderTable();
  });

  /* ---------- <cw-column a="358" b="267" op="+" steps> 竖式 ---------- */

  define('cw-column', function () {
    const op = (this.getAttribute('op') || '+').replace('x', '×').replace('*', '×').replace('-', '−');
    const aStr = this.getAttribute('a') || '0';
    const bStr = this.getAttribute('b') || '0';
    const stepped = this.hasAttribute('steps');
    const grid = html('div', { class: 'cw-column' }, this);
    const cells = [];
    let width = 0;

    function put(row, col, text, cls, order) {
      cells.push({ row: row, col: col, text: text, cls: cls || '', order: order === undefined ? -1 : order });
    }

    function decimals(s) {
      const i = s.indexOf('.');
      return i < 0 ? 0 : s.length - i - 1;
    }

    if (op === '+' || op === '−') {
      const d = Math.max(decimals(aStr), decimals(bStr));
      const f = 10 ** d;
      const aInt = Math.round(parseFloat(aStr) * f);
      const bInt = Math.round(parseFloat(bStr) * f);
      const rInt = op === '+' ? aInt + bInt : aInt - bInt;
      const aDigits = String(aInt).split('').reverse();
      const bDigits = String(bInt).split('').reverse();
      const rDigits = String(rInt).split('').reverse();
      while (aDigits.length <= d) aDigits.push('0');
      while (bDigits.length <= d) bDigits.push('0');
      while (rDigits.length <= d) rDigits.push('0');
      const n = Math.max(aDigits.length, bDigits.length, rDigits.length);
      width = n + 1 + (d ? 1 : 0);
      // Columns from the right; a decimal point takes its own narrow column.
      const colOf = (k) => width - k - (d && k >= d ? 1 : 0);
      // Operands keep the digits they were written with: 3.5 above 1.25 leaves the hundredths blank.
      for (let k = d - decimals(aStr); k < aDigits.length; k++) put(1, colOf(k), aDigits[k]);
      for (let k2 = d - decimals(bStr); k2 < bDigits.length; k2++) put(2, colOf(k2), bDigits[k2]);
      put(2, colOf(Math.max(aDigits.length, bDigits.length)), op);
      if (d) {
        put(1, width - d, '.');
        put(2, width - d, '.');
        put(5, width - d, '.', 'cw-result', d);
      }
      let carry = 0;
      for (let c = 0; c < n; c++) {
        const av = parseInt(aDigits[c] || '0', 10);
        const bv = parseInt(bDigits[c] || '0', 10);
        if (op === '+') {
          const sum = av + bv + carry;
          carry = sum >= 10 ? 1 : 0;
          if (carry && c + 1 < n) put(3, colOf(c + 1), '1', 'cw-carry', c);
        } else {
          const diff = av - bv - carry;
          const borrowed = diff < 0;
          carry = borrowed ? 1 : 0;
          if (borrowed) put(1, colOf(c + 1), '', 'cw-borrow-host', c);
        }
        if (c < rDigits.length) put(5, colOf(c), rDigits[c], 'cw-result', c);
      }
      put(4, 0, '', 'cw-rule', -2);
    } else if (op === '×') {
      const a = parseInt(aStr, 10);
      const bDigs = bStr.split('').reverse();
      const aD = aStr.split('').reverse();
      const product = String(a * parseInt(bStr, 10))
        .split('')
        .reverse();
      width = Math.max(product.length, aD.length, bDigs.length + 1) + 1;
      aD.forEach((ch, k) => {
        put(1, width - k, ch);
      });
      bDigs.forEach((ch, k) => {
        put(2, width - k, ch);
      });
      put(2, width - Math.max(aD.length, bDigs.length), '×');
      put(3, 0, '', 'cw-rule', -2);
      if (bDigs.length === 1) {
        product.forEach((ch, k) => {
          put(4, width - k, ch, 'cw-result', k);
        });
      } else {
        bDigs.forEach((ch, row) => {
          const partial = String(a * parseInt(ch, 10))
            .split('')
            .reverse();
          partial.forEach((p, k) => {
            put(4 + row, width - k - row, p, 'cw-result', row);
          });
        });
        const last = 4 + bDigs.length;
        put(last, 0, '', 'cw-rule', -2);
        product.forEach((ch, k) => {
          put(last + 1, width - k, ch, 'cw-result', bDigs.length);
        });
      }
    }

    // DOM order = reveal order, so unnumbered data-step reveals them right to left; the grid places them.
    cells.sort((x, y) => x.order - y.order);
    grid.style.gridTemplateColumns = `repeat(${width + 1}, auto)`;
    let shown = null;
    cells.forEach((cell) => {
      const node = html('div', { class: `cw-cell ${cell.cls}`, text: cell.text }, grid);
      node.style.gridRow = String(cell.row);
      if (cell.cls === 'cw-rule') {
        node.style.gridColumn = `1 / ${width + 2}`;
      } else {
        node.style.gridColumn = String(cell.col + 1);
      }
      if (cell.text === '.') node.style.width = '0.35em';
      if (cell.cls === 'cw-borrow-host') {
        node.className = 'cw-cell';
        node.style.zIndex = '1';
        html('span', { class: 'cw-borrow' }, node);
      }
      // Cells of the same order (a digit and its carry) appear together: "&" joins the previous step.
      if (stepped && cell.order >= 0) node.setAttribute('data-step', cell.order === shown ? '&' : '');
      shown = cell.order;
    });
  });

  /* ---------- Shared by the secondary-school tools ---------- */

  /** Bold text with a background-coloured outline, readable over grid lines and axes. */
  const HALO = { 'font-weight': 700, stroke: 'var(--bg)', 'stroke-width': 8, 'paint-order': 'stroke' };

  /** "−3,6" → [-3, 6]. */
  function range(el, name, fallback) {
    const v = list(el, name).map((t) => parseFloat(t.replace('−', '-')));
    return v.length === 2 && v[0] < v[1] ? v : fallback;
  }

  /** Splits on `sep` outside parentheses. */
  function splitTop(text, sep) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && sep.test(c)) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    out.push(text.slice(start));
    return out.map((t) => t.trim()).filter(Boolean);
  }

  /** Expression in x (and parameters) → function; accepts ^, ×, ÷, −, √ and Math names (sqrt, abs, sin, PI …). */
  function compile(expr, names) {
    const body = expr
      .replace(/−/g, '-')
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/√/g, 'sqrt')
      .replace(/\^/g, '**');
    return new Function(...names, `with (Math) { return (${body}); }`);
  }

  /**
   * Fills {name} placeholders with values and tidies the result the way a textbook writes it:
   * "y = 1x + -2" → "y = x − 2", "y = 0x + 3" → "y = 3". Terms must be separated by " + " or " − ".
   */
  function formula(template, values) {
    let text = template.replace(/\{(\w+)\}/g, (m, name) => (name in values ? signed(values[name]) : m));
    text = text.replace(/\+ −/g, '− ').replace(/− −/g, '+ ');
    // (x − 0)² → x²
    text = text.replace(/\((\w) [+−] 0\)/g, '$1');
    const eq = text.indexOf('=');
    const lhs = eq >= 0 ? `${text.slice(0, eq + 1)} ` : '';
    const rhs = eq >= 0 ? text.slice(eq + 1).trim() : text.trim();
    const terms = [];
    let depth = 0;
    let start = 0;
    let sign = 1;
    for (let i = 0; i <= rhs.length; i++) {
      const c = rhs[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      const op = depth === 0 && (c === '+' || c === '−') && rhs[i - 1] === ' ' && rhs[i + 1] === ' ';
      if (op || i === rhs.length) {
        terms.push({ sign: sign, body: rhs.slice(start, i).trim() });
        sign = c === '−' ? -1 : 1;
        start = i + 1;
      }
    }
    const kept = [];
    terms.forEach((t) => {
      let body = t.body;
      let s = t.sign;
      if (body[0] === '−') {
        s = -s;
        body = body.slice(1);
      }
      const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(body);
      if (m) {
        if (parseFloat(m[1]) === 0) return;
        if (m[1] === '1' && /^[a-zA-Z(√]/.test(m[2])) body = m[2];
      }
      if (body) kept.push({ sign: s, body: body });
    });
    if (!kept.length) return `${lhs}0`;
    return (
      lhs +
      kept
        .map((t, i) => (i === 0 ? (t.sign < 0 ? '−' : '') + t.body : `${t.sign < 0 ? '− ' : '+ '}${t.body}`))
        .join(' ')
    );
  }

  /** Range sliders for "k=1,-3,3,0.5; b=0,-4,4,1" (name=value,min,max,step); blur after use so the clicker keeps paging. */
  function sliders(el, spec, onChange) {
    const values = {};
    const row = html('div', { class: 'cw-sliders' });
    splitTop(spec || '', /;/).forEach((part) => {
      const m = /^(\w+)\s*=\s*(.+)$/.exec(part);
      if (!m) return;
      const n = m[2].split(',').map((t) => parseFloat(t.replace('−', '-')));
      const name = m[1];
      values[name] = n[0];
      const label = html('label', {}, row);
      html('i', { text: name }, label);
      const input = html(
        'input',
        { type: 'range', min: n[1], max: n[2], step: Number.isNaN(n[3]) ? 1 : n[3], value: n[0] },
        label,
      );
      const out = html('b', { text: signed(n[0]) }, label);
      input.addEventListener('input', () => {
        values[name] = parseFloat(input.value);
        out.textContent = signed(values[name]);
        onChange();
      });
      input.addEventListener('pointerup', () => input.blur());
      input.addEventListener('change', () => input.blur());
    });
    if (row.childNodes.length) el.appendChild(row);
    return values;
  }

  /* ---------- <cw-graph x="-6,6" y="-4,6" fn="k*x+b" params="k=1,-3,3,0.5;b=0,-4,4,1" label="y = {k}x + {b}"> ---------- */

  define('cw-graph', function () {
    const self = this;
    const xr = range(this, 'x', [-6, 6]);
    const yr = range(this, 'y', [-5, 5]);
    const step = num(this, 'step', 1);
    const snap = num(this, 'snap', 1);
    const unit = Math.min(num(this, 'width', 1000) / (xr[1] - xr[0]), num(this, 'height', 540) / (yr[1] - yr[0]));
    const pad = 44;
    const w = (xr[1] - xr[0]) * unit + pad * 2;
    const h = (yr[1] - yr[0]) * unit + pad * 2;
    const marks = (this.getAttribute('marks') || '').split(/\s+/);
    const exprs = splitTop(this.getAttribute('fn') || '', /;/);
    const templates = splitTop(this.getAttribute('label') || '', /;/);
    const pointSpec = this.getAttribute('points') || '';

    const root = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    this.appendChild(root);
    const readout = html('div', { class: 'cw-readout small' }, this);
    const params = sliders(this, this.getAttribute('params'), render);
    const names = ['x'].concat(Object.keys(params));
    const fns = exprs.map((e) => compile(e, names));

    function X(x) {
      return pad + (x - xr[0]) * unit;
    }
    function Y(y) {
      return pad + (yr[1] - y) * unit;
    }
    function f(k, x) {
      const args = [x].concat(Object.keys(params).map((n) => params[n]));
      const y = fns[k].apply(null, args);
      return typeof y === 'number' && Number.isFinite(y) ? y : NaN;
    }

    const clipId = `cw-clip-${Math.random().toString(36).slice(2)}`;
    const clip = svg('clipPath', { id: clipId }, svg('defs', {}, root));
    svg('rect', { x: pad, y: pad, width: w - pad * 2, height: h - pad * 2 }, clip);

    const labelEvery = (xr[1] - xr[0]) / step > 16 || (yr[1] - yr[0]) / step > 16 ? step * 2 : step;
    const grid = svg('g', {}, root);
    for (let gx = Math.ceil(xr[0] / step) * step; gx <= xr[1] + 1e-9; gx += step) {
      svg('line', { x1: X(gx), x2: X(gx), y1: Y(yr[0]), y2: Y(yr[1]), stroke: 'var(--line)', 'stroke-width': 2 }, grid);
      const near = Math.abs(gx / labelEvery - Math.round(gx / labelEvery)) < 1e-6;
      if (near && Math.abs(gx) > 1e-9 && yr[0] <= 0 && yr[1] >= 0) {
        svg(
          'text',
          { x: X(gx), y: Y(0) + 36, 'text-anchor': 'middle', 'font-size': 26, fill: 'var(--muted)', text: signed(gx) },
          grid,
        );
      }
    }
    for (let gy = Math.ceil(yr[0] / step) * step; gy <= yr[1] + 1e-9; gy += step) {
      svg('line', { x1: X(xr[0]), x2: X(xr[1]), y1: Y(gy), y2: Y(gy), stroke: 'var(--line)', 'stroke-width': 2 }, grid);
      const near = Math.abs(gy / labelEvery - Math.round(gy / labelEvery)) < 1e-6;
      if (near && Math.abs(gy) > 1e-9 && xr[0] <= 0 && xr[1] >= 0) {
        svg(
          'text',
          { x: X(0) - 14, y: Y(gy) + 9, 'text-anchor': 'end', 'font-size': 26, fill: 'var(--muted)', text: signed(gy) },
          grid,
        );
      }
    }
    if (yr[0] <= 0 && yr[1] >= 0) {
      svg(
        'line',
        { x1: X(xr[0]) - 16, x2: X(xr[1]) + 22, y1: Y(0), y2: Y(0), stroke: 'var(--ink)', 'stroke-width': 4 },
        grid,
      );
      svg('path', { d: `M${X(xr[1]) + 34} ${Y(0)}l-22 -11v22z`, fill: 'var(--ink)' }, grid);
      svg(
        'text',
        { x: X(xr[1]) + 20, y: Y(0) + 40, 'font-size': 32, 'font-style': 'italic', fill: 'var(--ink)', text: 'x' },
        grid,
      );
    }
    if (xr[0] <= 0 && xr[1] >= 0) {
      svg(
        'line',
        { x1: X(0), x2: X(0), y1: Y(yr[0]) + 16, y2: Y(yr[1]) - 22, stroke: 'var(--ink)', 'stroke-width': 4 },
        grid,
      );
      svg('path', { d: `M${X(0)} ${Y(yr[1]) - 34}l-11 22h22z`, fill: 'var(--ink)' }, grid);
      svg(
        'text',
        { x: X(0) + 16, y: Y(yr[1]) - 16, 'font-size': 32, 'font-style': 'italic', fill: 'var(--ink)', text: 'y' },
        grid,
      );
      if (yr[0] <= 0 && yr[1] >= 0) {
        svg(
          'text',
          { x: X(0) - 14, y: Y(0) + 36, 'text-anchor': 'end', 'font-size': 28, fill: 'var(--ink)', text: 'O' },
          grid,
        );
      }
    }

    const curves = svg('g', { 'clip-path': `url(#${clipId})` }, root);
    const markLayer = svg('g', {}, root);
    const pointLayer = svg('g', {}, root);

    // A(1,2) is a free point; P(2) slides along the first function.
    const points = [];
    const re = /([A-Za-z][\w']*)\(([^)]*)\)/g;
    let m = re.exec(pointSpec);
    while (m) {
      const xy = m[2].split(',').map((t) => parseFloat(t.replace('−', '-')));
      const g = svg('g', { class: 'cw-handle' }, pointLayer);
      const pt = { name: m[1], x: xy[0], y: xy.length > 1 ? xy[1] : NaN, glide: xy.length < 2, g: g };
      svg('circle', { r: 30, fill: 'transparent' }, g);
      svg('circle', { r: 14, fill: pt.glide ? 'var(--accent)' : 'var(--c5)', stroke: '#fff', 'stroke-width': 4 }, g);
      pt.text = svg('text', { x: 18, y: -18, 'font-size': 30, fill: 'var(--ink)', ...HALO }, g);
      draggable(root, g, (p) => {
        const sx = (p.x - pad) / unit + xr[0];
        const sy = yr[1] - (p.y - pad) / unit;
        const q = (v) => (snap ? Math.round(v / snap) * snap : Math.round(v * 100) / 100);
        pt.x = Math.max(xr[0], Math.min(xr[1], q(sx)));
        if (!pt.glide) pt.y = Math.max(yr[0], Math.min(yr[1], q(sy)));
        render();
      });
      points.push(pt);
      m = re.exec(pointSpec);
    }

    function dot(x, y, color, text, anchor) {
      svg('circle', { cx: X(x), cy: Y(y), r: 9, fill: color }, markLayer);
      if (text)
        svg(
          'text',
          {
            x: X(x) + (anchor === 'end' ? -14 : 14),
            y: Y(y) - 14,
            'text-anchor': anchor || 'start',
            'font-size': 26,
            fill: color,
            text: text,
            ...HALO,
          },
          markLayer,
        );
    }

    function coord(x, y) {
      return `(${signed(Math.round(x * 100) / 100)}, ${signed(Math.round(y * 100) / 100)})`;
    }

    function drawMarks(k, color) {
      const n = 800;
      const dx = (xr[1] - xr[0]) / n;
      const roots = [];
      const turns = [];
      let prev = f(k, xr[0]);
      let prevSlope = NaN;
      for (let i = 1; i <= n; i++) {
        const x = xr[0] + i * dx;
        const y = f(k, x);
        if (!Number.isNaN(prev) && !Number.isNaN(y)) {
          if (prev === 0) roots.push(x - dx);
          else if (prev * y < 0 && Math.abs(y - prev) < (yr[1] - yr[0]) / 2) {
            let a = x - dx;
            let b = x;
            for (let j = 0; j < 40; j++) {
              const c = (a + b) / 2;
              if (f(k, a) * f(k, c) <= 0) b = c;
              else a = c;
            }
            roots.push((a + b) / 2);
          }
          const slope = y - prev;
          if (!Number.isNaN(prevSlope) && prevSlope * slope < 0) turns.push(x - dx);
          prevSlope = slope;
        } else prevSlope = NaN;
        prev = y;
      }
      if (marks.indexOf('intercepts') >= 0) {
        roots.forEach((x) => {
          dot(x, 0, color, coord(x, 0));
        });
        const y0 = f(k, 0);
        if (xr[0] <= 0 && xr[1] >= 0 && !Number.isNaN(y0) && y0 >= yr[0] && y0 <= yr[1] && Math.abs(y0) > 1e-9)
          dot(0, y0, color, coord(0, y0));
      }
      turns.forEach((x0) => {
        // Refine the turning point with a ternary search around the sample.
        let a = x0 - dx;
        let b = x0 + dx;
        const up = f(k, x0) > f(k, a);
        for (let j = 0; j < 40; j++) {
          const m1 = a + (b - a) / 3;
          const m2 = b - (b - a) / 3;
          if (f(k, m1) < f(k, m2) === up) a = m1;
          else b = m2;
        }
        const vx = Math.abs((a + b) / 2) < 1e-6 ? 0 : (a + b) / 2;
        const vy = f(k, vx);
        if (marks.indexOf('axis') >= 0) {
          svg(
            'line',
            {
              x1: X(vx),
              x2: X(vx),
              y1: Y(yr[0]),
              y2: Y(yr[1]),
              stroke: color,
              'stroke-width': 3,
              'stroke-dasharray': '10 8',
            },
            markLayer,
          );
          svg(
            'text',
            {
              x: X(vx) + 10,
              y: Y(yr[0]) - 12,
              'font-size': 26,
              fill: color,
              text: `x = ${signed(Math.round(vx * 100) / 100)}`,
              ...HALO,
            },
            markLayer,
          );
        }
        if (marks.indexOf('vertex') >= 0 && vy >= yr[0] && vy <= yr[1]) dot(vx, vy, color, `顶点${coord(vx, vy)}`);
      });
    }

    function render() {
      while (curves.firstChild) curves.removeChild(curves.firstChild);
      while (markLayer.firstChild) markLayer.removeChild(markLayer.firstChild);
      const lines = [];
      fns.forEach((_, k) => {
        const color = PALETTE[k % PALETTE.length];
        const n = 800;
        let d = '';
        let pen = false;
        let lastY = NaN;
        for (let i = 0; i <= n; i++) {
          const x = xr[0] + ((xr[1] - xr[0]) * i) / n;
          const y = f(k, x);
          // Lift the pen at gaps and jumps (y = k/x around 0).
          const jump = !Number.isNaN(lastY) && Math.abs(y - lastY) > (yr[1] - yr[0]) * 2;
          if (Number.isNaN(y) || Math.abs(y) > 1e6 || jump) {
            pen = false;
            lastY = NaN;
            if (Number.isNaN(y) || Math.abs(y) > 1e6) continue;
          }
          d += `${pen ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(Math.max(yr[0] - 50, Math.min(yr[1] + 50, y))).toFixed(1)}`;
          pen = true;
          lastY = y;
        }
        svg('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 6, 'stroke-linejoin': 'round' }, curves);
        drawMarks(k, color);
        const t = templates[k];
        if (t) lines.push(`<span style="color:${color}">${formula(t, params)}</span>`);
      });
      points.forEach((pt) => {
        if (pt.glide) pt.y = fns.length ? f(0, pt.x) : 0;
        const ok = !Number.isNaN(pt.y);
        pt.g.style.display = ok ? '' : 'none';
        if (!ok) return;
        pt.g.setAttribute('transform', `translate(${X(pt.x)},${Y(pt.y)})`);
        pt.text.textContent = pt.name + coord(pt.x, pt.y);
        const dash = { stroke: 'var(--muted)', 'stroke-width': 3, 'stroke-dasharray': '8 8' };
        if (yr[0] <= 0 && yr[1] >= 0)
          svg('line', Object.assign({ x1: X(pt.x), x2: X(pt.x), y1: Y(pt.y), y2: Y(0) }, dash), markLayer);
        if (xr[0] <= 0 && xr[1] >= 0)
          svg('line', Object.assign({ x1: X(pt.x), x2: X(0), y1: Y(pt.y), y2: Y(pt.y) }, dash), markLayer);
      });
      if (!self.hasAttribute('hide-readout')) readout.innerHTML = lines.join('<span style="width:48px"></span>');
    }
    render();
  });

  /* ---------- <cw-geometry figure="A(1,1) B(8,1) C(3,6); M=mid(A,B); poly(A,B,C); seg(C,M); angle(B,A,C)"> ---------- */

  define('cw-geometry', function () {
    const self = this;
    const scale = num(this, 'scale', 80);
    const width = num(this, 'width', 1200);
    const height = num(this, 'height', 600);
    const snap = num(this, 'snap', 0);
    const unit = this.getAttribute('unit') || '';
    const cols = width / scale;
    const rows = height / scale;
    const pad = 30;

    const root = svg('svg', {
      width: width + pad * 2,
      height: height + pad * 2,
      viewBox: `0 0 ${width + pad * 2} ${height + pad * 2}`,
    });
    this.appendChild(root);
    const readout = html('div', { class: 'cw-readout small' }, this);
    if (this.hasAttribute('grid')) {
      for (let gx = 0; gx <= cols + 1e-9; gx++)
        svg(
          'line',
          {
            x1: pad + gx * scale,
            x2: pad + gx * scale,
            y1: pad,
            y2: pad + height,
            stroke: 'var(--line)',
            'stroke-width': 2,
          },
          root,
        );
      for (let gy = 0; gy <= rows + 1e-9; gy++)
        svg(
          'line',
          {
            x1: pad,
            x2: pad + width,
            y1: pad + gy * scale,
            y2: pad + gy * scale,
            stroke: 'var(--line)',
            'stroke-width': 2,
          },
          root,
        );
    }
    // Lines and rays run to the edge of the board, not beyond it.
    const clipId = `cw-clip-${Math.random().toString(36).slice(2)}`;
    const clip = svg('clipPath', { id: clipId }, svg('defs', {}, root));
    svg('rect', { x: pad, y: pad, width: width, height: height }, clip);
    const fillLayer = svg('g', { 'clip-path': `url(#${clipId})` }, root);
    const lineLayer = svg('g', { 'clip-path': `url(#${clipId})` }, root);
    const markLayer = svg('g', {}, root);
    const pointLayer = svg('g', {}, root);

    function X(p) {
      return pad + p.x * scale;
    }
    function Y(p) {
      return pad + height - p.y * scale;
    }
    function sub(a, b) {
      return { x: a.x - b.x, y: a.y - b.y };
    }
    function dist(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function cross(a, b, c, d) {
      const r = sub(b, a);
      const q = sub(d, c);
      const den = r.x * q.y - r.y * q.x;
      if (Math.abs(den) < 1e-12) return { x: NaN, y: NaN };
      const t = ((c.x - a.x) * q.y - (c.y - a.y) * q.x) / den;
      return { x: a.x + r.x * t, y: a.y + r.y * t };
    }
    function foot(p, a, b) {
      const d = sub(b, a);
      const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / (d.x * d.x + d.y * d.y);
      return { x: a.x + d.x * t, y: a.y + d.y * t };
    }
    function rotate(p, o, deg) {
      const r = (deg * Math.PI) / 180;
      const v = sub(p, o);
      return { x: o.x + v.x * Math.cos(r) - v.y * Math.sin(r), y: o.y + v.x * Math.sin(r) + v.y * Math.cos(r) };
    }
    function angleAt(b, a, c) {
      const u = sub(b, a);
      const v = sub(c, a);
      const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
      return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    }
    function area(ps) {
      let sum = 0;
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i];
        const b = ps[(i + 1) % ps.length];
        sum += a.x * b.y - b.x * a.y;
      }
      return Math.abs(sum) / 2;
    }
    function circum(a, b, c) {
      const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
      const a2 = a.x * a.x + a.y * a.y;
      const b2 = b.x * b.x + b.y * b.y;
      const c2 = c.x * c.x + c.y * c.y;
      return {
        x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
        y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
      };
    }
    const constructions = {
      mid: (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }),
      foot: (p) => foot(p[0], p[1], p[2]),
      centroid: (p) => ({ x: (p[0].x + p[1].x + p[2].x) / 3, y: (p[0].y + p[1].y + p[2].y) / 3 }),
      circum: (p) => circum(p[0], p[1], p[2]),
      incenter: (p) => {
        const a = dist(p[1], p[2]);
        const b = dist(p[0], p[2]);
        const c = dist(p[0], p[1]);
        const s = a + b + c;
        return { x: (a * p[0].x + b * p[1].x + c * p[2].x) / s, y: (a * p[0].y + b * p[1].y + c * p[2].y) / s };
      },
      orthocenter: (p) => cross(p[0], foot(p[0], p[1], p[2]), p[1], foot(p[1], p[0], p[2])),
      cross: (p) => cross(p[0], p[1], p[2], p[3]),
      reflect: (p) => {
        const f = foot(p[0], p[1], p[2]);
        return { x: 2 * f.x - p[0].x, y: 2 * f.y - p[0].y };
      },
      rotate: (p, n) => rotate(p[0], p[1], n[0]),
      translate: (p) => ({ x: p[0].x + p[2].x - p[1].x, y: p[0].y + p[2].y - p[1].y }),
    };

    const pts = {};
    const order = [];
    const shapes = [];
    const errors = [];

    function args(text) {
      const refs = [];
      const nums = [];
      text.split(',').forEach((t) => {
        const v = t.trim();
        if (!v) return;
        if (/^[−-]?\d/.test(v)) nums.push(parseFloat(v.replace('−', '-')));
        else refs.push(v);
      });
      return { refs: refs, nums: nums };
    }

    // Statements are separated by ";", new lines or spaces: "A(1,1) B(8,1); M = mid(A, B)".
    const figure = (this.getAttribute('figure') || '')
      .replace(/\s*=\s*/g, '=')
      .replace(/\s*,\s*/g, ',')
      .replace(/\s*\(/g, '(');
    splitTop(figure, /[;\s]/).forEach((stmt) => {
      let m = /^([A-Za-z][\w']*)\s*\(\s*([−\d.-]+)\s*,\s*([−\d.-]+)\s*\)$/.exec(stmt);
      if (m) {
        pts[m[1]] = {
          name: m[1],
          x: parseFloat(m[2].replace('−', '-')),
          y: parseFloat(m[3].replace('−', '-')),
          free: true,
        };
        order.push(m[1]);
        return;
      }
      m = /^([A-Za-z][\w']*)\s*=\s*(\w+)\s*\((.*)\)$/.exec(stmt);
      if (m) {
        const a = args(m[3]);
        const kind = m[2];
        if (kind === 'on' || kind === 'oncircle') {
          // A point the students drag along segment AB (t from A to B) or around the circle centred O through A.
          pts[m[1]] = {
            name: m[1],
            kind: kind,
            refs: a.refs,
            t: a.nums.length ? a.nums[0] : kind === 'on' ? 0.5 : 60,
            x: 0,
            y: 0,
          };
        } else if (constructions[kind]) {
          pts[m[1]] = { name: m[1], kind: kind, refs: a.refs, nums: a.nums, x: 0, y: 0 };
        } else {
          errors.push(stmt);
          return;
        }
        order.push(m[1]);
        return;
      }
      m = /^(\w+)\s*\((.*)\)$/.exec(stmt);
      if (m && /^(seg|dseg|line|ray|poly|circle|angle|len|area)$/.test(m[1])) {
        const a = args(m[2]);
        shapes.push({ kind: m[1], refs: a.refs, nums: a.nums, color: PALETTE[shapes.length % PALETTE.length] });
        return;
      }
      errors.push(stmt);
    });

    function update() {
      order.forEach((name) => {
        const p = pts[name];
        if (p.free) return;
        const ref = p.refs.map((r) => pts[r]);
        if (ref.some((r) => !r)) {
          p.x = NaN;
          p.y = NaN;
          return;
        }
        let q;
        if (p.kind === 'on')
          q = { x: ref[0].x + (ref[1].x - ref[0].x) * p.t, y: ref[0].y + (ref[1].y - ref[0].y) * p.t };
        else if (p.kind === 'oncircle') q = rotate({ x: ref[0].x + dist(ref[0], ref[1]), y: ref[0].y }, ref[0], p.t);
        else q = constructions[p.kind](ref, p.nums);
        p.x = q.x;
        p.y = q.y;
      });
    }

    function clampedPoint(e) {
      return {
        x: Math.max(0, Math.min(cols, (e.x - pad) / scale)),
        y: Math.max(0, Math.min(rows, (pad + height - e.y) / scale)),
      };
    }

    // Labels sit away from the middle of the figure.
    function labelOffset(p) {
      const names = Object.keys(pts);
      let cx = 0;
      let cy = 0;
      names.forEach((n) => {
        cx += pts[n].x || 0;
        cy += pts[n].y || 0;
      });
      cx /= names.length;
      cy /= names.length;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: (dx / len) * 34, y: (-dy / len) * 34 };
    }

    const handles = order.map((name) => {
      const p = pts[name];
      const g = svg('g', {}, pointLayer);
      const movable = p.free || p.kind === 'on' || p.kind === 'oncircle';
      if (movable) {
        g.setAttribute('class', 'cw-handle');
        svg('circle', { r: 30, fill: 'transparent' }, g);
      }
      svg(
        'circle',
        { r: movable ? 13 : 9, fill: movable ? 'var(--ink)' : 'var(--accent)', stroke: '#fff', 'stroke-width': 4 },
        g,
      );
      const text = svg(
        'text',
        {
          'text-anchor': 'middle',
          'font-size': 34,
          'font-style': 'italic',
          'font-weight': 700,
          fill: 'var(--ink)',
          text: name,
        },
        g,
      );
      if (movable)
        draggable(root, g, (e) => {
          const q = clampedPoint(e);
          if (p.free) {
            p.x = snap ? Math.round(q.x / snap) * snap : q.x;
            p.y = snap ? Math.round(q.y / snap) * snap : q.y;
          } else if (p.kind === 'on') {
            const a = pts[p.refs[0]];
            const b = pts[p.refs[1]];
            const d = sub(b, a);
            const t = ((q.x - a.x) * d.x + (q.y - a.y) * d.y) / (d.x * d.x + d.y * d.y);
            p.t = Math.max(0, Math.min(1, t));
          } else {
            const o = pts[p.refs[0]];
            p.t = (Math.atan2(q.y - o.y, q.x - o.x) * 180) / Math.PI;
          }
          render();
        });
      return { p: p, g: g, text: text };
    });

    /**
     * Whole degrees for each angle(); when a triangle's three angles are all shown they are rounded together
     * (largest remainder) so they add up to exactly 180°, as students expect.
     */
    function roundedAngles() {
      const out = {};
      const groups = {};
      shapes.forEach((sh, index) => {
        if (sh.kind !== 'angle') return;
        const ps = sh.refs.map((r) => pts[r]);
        if (ps.length !== 3 || ps.some((p) => !p || Number.isNaN(p.x))) return;
        const raw = angleAt(ps[0], ps[1], ps[2]);
        out[index] = Math.round(raw);
        const key = sh.refs.slice().sort().join();
        if (!groups[key]) groups[key] = [];
        groups[key].push({ index: index, raw: raw, vertex: sh.refs[1] });
      });
      Object.keys(groups).forEach((key) => {
        const g = groups[key];
        if (g.length !== 3 || new Set(g.map((a) => a.vertex)).size !== 3) return;
        g.forEach((a) => {
          out[a.index] = Math.floor(a.raw);
        });
        let left = 180 - g.reduce((sum, a) => sum + out[a.index], 0);
        g.slice()
          .sort((a, b) => (b.raw % 1) - (a.raw % 1))
          .forEach((a) => {
            if (left > 0) {
              out[a.index]++;
              left--;
            }
          });
      });
      return out;
    }

    function fmtLen(v) {
      return Math.round(v * 10) / 10;
    }

    function render() {
      update();
      [fillLayer, lineLayer, markLayer].forEach((layer) => {
        while (layer.firstChild) layer.removeChild(layer.firstChild);
      });
      const measures = [];
      const degrees = roundedAngles();
      shapes.forEach((sh, index) => {
        const ps = sh.refs.map((r) => pts[r]).filter(Boolean);
        if (ps.length !== sh.refs.length || ps.some((p) => Number.isNaN(p.x))) return;
        const line = { stroke: 'var(--ink)', 'stroke-width': 5, 'stroke-linecap': 'round' };
        if (sh.kind === 'seg' || sh.kind === 'dseg') {
          const attrs = Object.assign({ x1: X(ps[0]), y1: Y(ps[0]), x2: X(ps[1]), y2: Y(ps[1]) }, line);
          if (sh.kind === 'dseg') {
            attrs['stroke-dasharray'] = '12 10';
            attrs.stroke = 'var(--muted)';
          }
          svg('line', attrs, lineLayer);
        } else if (sh.kind === 'line' || sh.kind === 'ray') {
          const d = sub(ps[1], ps[0]);
          const k = ((cols + rows) * 2) / (Math.hypot(d.x, d.y) || 1);
          const from = sh.kind === 'line' ? { x: ps[0].x - d.x * k, y: ps[0].y - d.y * k } : ps[0];
          const to = { x: ps[0].x + d.x * k, y: ps[0].y + d.y * k };
          svg('line', Object.assign({ x1: X(from), y1: Y(from), x2: X(to), y2: Y(to) }, line), lineLayer);
        } else if (sh.kind === 'poly') {
          svg(
            'polygon',
            {
              points: ps.map((p) => `${X(p)},${Y(p)}`).join(' '),
              fill: sh.color,
              'fill-opacity': 0.18,
              stroke: 'var(--ink)',
              'stroke-width': 5,
              'stroke-linejoin': 'round',
            },
            fillLayer,
          );
        } else if (sh.kind === 'circle') {
          const r = ps.length > 1 ? dist(ps[0], ps[1]) : sh.nums[0] || 1;
          svg(
            'circle',
            { cx: X(ps[0]), cy: Y(ps[0]), r: r * scale, fill: 'none', stroke: sh.color, 'stroke-width': 5 },
            lineLayer,
          );
        } else if (sh.kind === 'angle') {
          const deg = angleAt(ps[0], ps[1], ps[2]);
          const a = ps[1];
          const r = 46;
          const u = sub(ps[0], a);
          const v = sub(ps[2], a);
          const lu = Math.hypot(u.x, u.y) || 1;
          const lv = Math.hypot(v.x, v.y) || 1;
          const p1 = { x: X(a) + (u.x / lu) * r, y: Y(a) - (u.y / lu) * r };
          const p2 = { x: X(a) + (v.x / lv) * r, y: Y(a) - (v.y / lv) * r };
          const shown = degrees[index];
          if (Math.abs(deg - 90) < 0.05) {
            const k = r * 0.62;
            const c = { x: X(a) + (u.x / lu + v.x / lv) * k, y: Y(a) - (u.y / lu + v.y / lv) * k };
            svg(
              'path',
              {
                d: `M${X(a) + (u.x / lu) * k} ${Y(a) - (u.y / lu) * k}L${c.x} ${c.y}L${X(a) + (v.x / lv) * k} ${Y(a) - (v.y / lv) * k}`,
                fill: 'none',
                stroke: sh.color,
                'stroke-width': 4,
              },
              markLayer,
            );
          } else {
            const sweep = u.x * v.y - u.y * v.x > 0 ? 0 : 1;
            svg(
              'path',
              {
                d: `M${p1.x} ${p1.y}A${r} ${r} 0 0 ${sweep} ${p2.x} ${p2.y}`,
                fill: 'none',
                stroke: sh.color,
                'stroke-width': 5,
              },
              markLayer,
            );
          }
          const bis = { x: u.x / lu + v.x / lv, y: u.y / lu + v.y / lv };
          const lb = Math.hypot(bis.x, bis.y) || 1;
          svg(
            'text',
            {
              x: X(a) + (bis.x / lb) * (r + 40),
              y: Y(a) - (bis.y / lb) * (r + 40) + 11,
              'text-anchor': 'middle',
              'font-size': 30,
              'font-weight': 700,
              fill: sh.color,
              text: `${shown}°`,
            },
            markLayer,
          );
          measures.push(`<span style="color:${sh.color}">∠${sh.refs.join('')} = ${shown}°</span>`);
        } else if (sh.kind === 'len') {
          const L = fmtLen(dist(ps[0], ps[1]));
          const mid = { x: (X(ps[0]) + X(ps[1])) / 2, y: (Y(ps[0]) + Y(ps[1])) / 2 };
          svg(
            'text',
            {
              x: mid.x,
              y: mid.y - 14,
              'text-anchor': 'middle',
              'font-size': 28,
              'font-weight': 700,
              fill: sh.color,
              stroke: 'var(--bg)',
              'stroke-width': 8,
              'paint-order': 'stroke',
              text: signed(L),
            },
            markLayer,
          );
          measures.push(`<span style="color:${sh.color}">${sh.refs.join('')} = ${signed(L)}${unit}</span>`);
        } else if (sh.kind === 'area') {
          const S = fmtLen(area(ps));
          const name = ps.length === 3 ? `S△${sh.refs.join('')}` : `S${sh.refs.join('')}`;
          measures.push(`<span style="color:${sh.color}">${name} = ${signed(S)}${unit ? `${unit}²` : ''}</span>`);
        }
      });
      handles.forEach((h) => {
        const ok = !Number.isNaN(h.p.x);
        h.g.style.display = ok ? '' : 'none';
        if (!ok) return;
        h.g.setAttribute('transform', `translate(${X(h.p)},${Y(h.p)})`);
        const off = labelOffset(h.p);
        h.text.setAttribute('x', off.x);
        h.text.setAttribute('y', off.y + 12);
      });
      if (errors.length) readout.innerHTML = `<span class="bad-text">无法识别：${errors.join('；')}</span>`;
      else if (!self.hasAttribute('hide-readout'))
        readout.innerHTML = measures.join('<span style="width:40px"></span>');
    }
    render();
  });

  /* ---------- <cw-algebra-tiles expr="x^2+3x+2" negative> ---------- */

  define('cw-algebra-tiles', function () {
    const self = this;
    const u = 56;
    const L = u * num(this, 'x', 3.4);
    const negative = this.hasAttribute('negative');
    const tray = 300;
    const width = num(this, 'width', 1560);
    const height = num(this, 'height', 640);
    const root = svg('svg', { width: width, height: height, viewBox: `0 0 ${width} ${height}` });
    this.appendChild(root);
    const readout = html('div', { class: 'cw-readout small' }, this);
    svg('rect', { x: 0, y: 0, width: tray, height: height, rx: 20, fill: 'var(--soft-primary)' }, root);
    svg(
      'rect',
      {
        x: tray + 20,
        y: 0,
        width: width - tray - 20,
        height: height,
        rx: 20,
        fill: 'var(--paper)',
        stroke: 'var(--line)',
        'stroke-width': 3,
      },
      root,
    );
    const tileLayer = svg('g', {}, root);
    const tiles = [];

    const KINDS = {
      x2: { w: L, h: L, label: 'x²' },
      x: { w: L, h: u, label: 'x' },
      1: { w: u, h: u, label: '1' },
    };

    function size(t) {
      const k = KINDS[t.kind];
      return t.turned ? { w: k.h, h: k.w } : { w: k.w, h: k.h };
    }

    function paint(t) {
      const z = size(t);
      t.rect.setAttribute('width', z.w);
      t.rect.setAttribute('height', z.h);
      t.text.setAttribute('x', z.w / 2);
      t.text.setAttribute('y', z.h / 2 + 12);
      t.g.setAttribute('transform', `translate(${t.x},${t.y})`);
    }

    function make(kind, sign, x, y, parent) {
      const k = KINDS[kind];
      const g = svg('g', { class: 'cw-handle' }, parent || tileLayer);
      const fill = sign > 0 ? { x2: 'var(--c1)', x: 'var(--c3)', 1: 'var(--c6)' }[kind] : 'var(--c4)';
      const rect = svg('rect', { rx: 6, fill: fill, stroke: 'var(--ink)', 'stroke-width': 3 }, g);
      const text = svg(
        'text',
        {
          'text-anchor': 'middle',
          'font-size': kind === '1' ? 28 : 32,
          'font-weight': 700,
          fill: '#fff',
          text: (sign < 0 ? '−' : '') + k.label,
        },
        g,
      );
      const t = { kind: kind, sign: sign, x: x, y: y, turned: false, g: g, rect: rect, text: text };
      paint(t);
      return t;
    }

    /** Pulls a dragged tile's edges onto nearby edges of other tiles, so they fit together without gaps. */
    function snapTile(t) {
      const z = size(t);
      let bestX = 18;
      let bestY = 18;
      let dx = 0;
      let dy = 0;
      tiles.forEach((o) => {
        if (o === t) return;
        const oz = size(o);
        [o.x - z.w, o.x, o.x + oz.w - z.w, o.x + oz.w].forEach((cand) => {
          if (Math.abs(cand - t.x) < bestX) {
            bestX = Math.abs(cand - t.x);
            dx = cand - t.x;
          }
        });
        [o.y - z.h, o.y, o.y + oz.h - z.h, o.y + oz.h].forEach((cand) => {
          if (Math.abs(cand - t.y) < bestY) {
            bestY = Math.abs(cand - t.y);
            dy = cand - t.y;
          }
        });
      });
      t.x += dx;
      t.y += dy;
    }

    function drag(t, event, fresh) {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const start = svgPoint(root, event);
      const off = { x: start.x - t.x, y: start.y - t.y };
      let moved = fresh;
      function move(e) {
        const p = svgPoint(root, e);
        if (Math.hypot(p.x - start.x, p.y - start.y) > 6) moved = true;
        t.x = p.x - off.x;
        t.y = p.y - off.y;
        paint(t);
      }
      function up() {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        const z = size(t);
        if (t.x + z.w / 2 < tray) {
          // Dropped back on the tray: take it away.
          tiles.splice(tiles.indexOf(t), 1);
          tileLayer.removeChild(t.g);
        } else if (!moved && t.kind === 'x') {
          // Turn around the centre, so the tile stays under the finger.
          t.x += (z.w - z.h) / 2;
          t.y += (z.h - z.w) / 2;
          t.turned = !t.turned;
          paint(t);
        } else {
          t.x = Math.max(tray + 24, Math.min(width - z.w - 4, t.x));
          t.y = Math.max(4, Math.min(height - z.h - 4, t.y));
          snapTile(t);
          paint(t);
        }
        render();
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    }

    function add(kind, sign, x, y) {
      const t = make(kind, sign, x, y);
      tiles.push(t);
      t.g.addEventListener('pointerdown', (e) => drag(t, e, false));
      return t;
    }

    // The tray: drag a new tile out of each source.
    const sourceLayer = svg('g', {}, root);
    const kinds = negative
      ? [
          ['x2', 1],
          ['x', 1],
          ['1', 1],
          ['x2', -1],
          ['x', -1],
          ['1', -1],
        ]
      : [
          ['x2', 1],
          ['x', 1],
          ['1', 1],
        ];
    let sy = 24;
    kinds.forEach((pair, i) => {
      const scaleDown = 0.55;
      const k = KINDS[pair[0]];
      const col = negative ? (i < 3 ? 0 : 1) : 0;
      if (negative && i === 3) sy = 24;
      const sx = negative ? 24 + col * 136 : (tray - k.w * scaleDown) / 2;
      const src = make(pair[0], pair[1], 0, 0, sourceLayer);
      src.g.setAttribute('transform', `translate(${sx},${sy}) scale(${scaleDown})`);
      src.g.addEventListener('pointerdown', (e) => {
        const p = svgPoint(root, e);
        const t = add(pair[0], pair[1], p.x - k.w / 2, p.y - k.h / 2);
        drag(t, e, true);
      });
      sy += k.h * scaleDown + 30;
    });

    function term(c, name, first) {
      if (!c) return '';
      const sign = c < 0 ? (first ? '−' : ' − ') : first ? '' : ' + ';
      const a = Math.abs(c);
      return sign + (a === 1 && name ? '' : String(a)) + name;
    }

    function poly(a, b, c) {
      let out = term(a, 'x²', true);
      out += term(b, 'x', !out);
      out += term(c, '', !out);
      return out || '0';
    }

    function factor(len) {
      // Split a side length into a·x + b, with x the long side of a tile.
      for (let a = 0; a <= 12; a++) {
        const b = (len - a * L) / u;
        if (b > -0.05 && Math.abs(b - Math.round(b)) < 0.05) return { a: a, b: Math.round(b) };
      }
      return null;
    }

    function side(f) {
      const text = poly(0, f.a, f.b);
      return f.a && f.b ? `(${text})` : text;
    }

    /** (x + 1)(x + 2), (x + 1)², 2(x + 3), x(x + 3), 2 × 3 … */
    function product(p, q) {
      if (p === q) return p.length > 1 && p[0] !== '(' ? `(${p})²` : `${p}²`;
      const plain = (t) => t[0] !== '(';
      const number = (t) => /^\d+$/.test(t);
      if (plain(q) && !plain(p)) return product(q, p);
      if (plain(p) && plain(q)) {
        if (number(p) && number(q)) return `${p} × ${q}`;
        if (number(q)) return product(q, p);
        return number(p) ? `${p}${q}` : `${p}·${q}`;
      }
      return `${p}${q}`;
    }

    function rectangle() {
      if (!tiles.length || tiles.some((t) => t.sign < 0)) return null;
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      let sum = 0;
      tiles.forEach((t) => {
        const z = size(t);
        x1 = Math.min(x1, t.x);
        y1 = Math.min(y1, t.y);
        x2 = Math.max(x2, t.x + z.w);
        y2 = Math.max(y2, t.y + z.h);
        sum += z.w * z.h;
      });
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          const a = tiles[i];
          const b = tiles[j];
          const za = size(a);
          const zb = size(b);
          const ox = Math.min(a.x + za.w, b.x + zb.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + za.h, b.y + zb.h) - Math.max(a.y, b.y);
          if (ox > 2 && oy > 2) return null;
        }
      }
      if (Math.abs((x2 - x1) * (y2 - y1) - sum) > u * u * 0.2) return null;
      const w = factor(x2 - x1);
      const h = factor(y2 - y1);
      return w && h ? product(side(h), side(w)) : null;
    }

    function render() {
      let a = 0;
      let b = 0;
      let c = 0;
      tiles.forEach((t) => {
        if (t.kind === 'x2') a += t.sign;
        else if (t.kind === 'x') b += t.sign;
        else c += t.sign;
      });
      if (self.hasAttribute('hide-readout')) return;
      if (!tiles.length) {
        readout.innerHTML = '<span class="muted">从左边拖出方块；点 x 条可以转向，拖回左边就拿走</span>';
        return;
      }
      const rect = rectangle();
      const shown = rect && tiles.length > 1 ? ` <span class="good-text">= ${rect}</span>` : '';
      readout.innerHTML = poly(a, b, c) + shown;
    }

    // Lay out the starting tiles of `expr` loosely on the mat, for students to arrange.
    const expr = (this.getAttribute('expr') || '').replace(/\s/g, '').replace(/²/g, '^2').replace(/−/g, '-');
    if (expr) {
      const coef = { x2: 0, x: 0, 1: 0 };
      (expr.match(/[+-]?[^+-]+/g) || []).forEach((t) => {
        const m = /^([+-]?)(\d*)(x\^2|x)?$/.exec(t);
        if (!m) return;
        const n = (m[1] === '-' ? -1 : 1) * (m[2] ? parseInt(m[2], 10) : m[3] ? 1 : 0);
        coef[m[3] === 'x^2' ? 'x2' : m[3] === 'x' ? 'x' : '1'] += n;
      });
      let x = tray + 60;
      let y = 40;
      let rowH = 0;
      ['x2', 'x', '1'].forEach((kind) => {
        const n = coef[kind];
        for (let i = 0; i < Math.abs(n); i++) {
          const k = KINDS[kind];
          if (x + k.w > width - 30) {
            x = tray + 60;
            y += rowH + 30;
            rowH = 0;
          }
          add(kind, n < 0 ? -1 : 1, x, y);
          x += k.w + 30;
          rowH = Math.max(rowH, k.h);
        }
      });
    }
    render();
  });
})();
