/**
 * The document a presenter's view runs in: a sandboxed iframe (opaque origin, no access to the site), with base
 * styles for phones and a `live` object bridged to the page by postMessage.
 */

const BASE_STYLE = `
:root {
  color-scheme: light;
  --accent: #4f5bd5;
  --good: #2e9d62;
  --bad: #d2463c;
  --line: #dfe1ea;
  --muted: #6b7080;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
[hidden] { display: none !important; }
body {
  min-height: 100vh;
  padding: 24px 20px calc(24px + env(safe-area-inset-bottom));
  background: #f6f7fb;
  color: #1f2330;
  font: 18px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  -webkit-tap-highlight-color: transparent;
}
h1, h2, h3 { margin: 0 0 16px; line-height: 1.3; }
p { margin: 0 0 16px; }
button {
  display: block;
  width: 100%;
  margin: 0 0 12px;
  padding: 16px 18px;
  border: 2px solid var(--line);
  border-radius: 14px;
  background: #fff;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
button:active { background: #eef0fb; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; text-align: center; }
button.selected { border-color: var(--accent); background: #eef0fb; }
button.right { border-color: var(--good); background: #e6f5ec; }
button.wrong { border-color: var(--bad); background: #fbe9e7; }
button:disabled { opacity: 0.6; cursor: default; }
input, textarea, select {
  display: block;
  width: 100%;
  margin: 0 0 12px;
  padding: 14px 16px;
  border: 2px solid var(--line);
  border-radius: 14px;
  background: #fff;
  font: inherit;
}
textarea { min-height: 120px; }
.muted { color: var(--muted); }
.center { text-align: center; }
`;

const bridge = (id: string) => `
window.live = {
  id: ${JSON.stringify(id)},
  onmessage: null,
  send(value) { parent.postMessage({ t: 'data', value }, '*'); },
};
addEventListener('message', (event) => {
  if (event.source !== parent || !event.data || event.data.t !== 'data') return;
  if (typeof live.onmessage === 'function') live.onmessage(event.data.value);
  dispatchEvent(new CustomEvent('live', { detail: event.data.value }));
});
`;

export const frameDocument = (html: string, id: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${BASE_STYLE}</style><script>${bridge(id)}</script></head><body>${html}</body></html>`;
