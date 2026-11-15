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

  /* ---------- <cw-number-line min="0" max="10" step="1" points="3" hops fractions="4"> ---------- */

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
    const values = list(this, 'points').map(parseFloat);
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
          { x: x, y: y + 66, 'text-anchor': 'middle', 'font-size': 38, fill: 'var(--ink)', text: fmt(v) },
          root,
        );
      }
    }

    const hopLayer = svg('g', {}, root);
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
      if (!denominator) return fmt(v);
      const n = Math.round(v * denominator);
      if (n % denominator === 0) return String(n / denominator);
      const g = gcd(n, denominator);
      return fracHtml(n, denominator) + (g > 1 ? ` = ${fracHtml(n / g, denominator / g)}` : '');
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
      if (self.hasAttribute('hide-readout')) return;
      readout.innerHTML = handles
        .map((h, k) => `<span style="color:${PALETTE[k % PALETTE.length]}">●</span> ${label(h.value)}`)
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
})();
