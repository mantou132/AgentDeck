---
name: widget
description: Embed a small interactive widget in your reply in the AgentDeck client. Use when the answer is better explored than read — calculators, configurators, what-if sliders, sortable or filterable comparisons, checklists, quizzes, step-by-step walkthroughs, or a few clickable options that send the user's choice back to you; answer with an `agentdeck-widget` fenced block holding an HTML fragment with an optional Preact + htm script. Not for plain charts (use `agentdeck-chart`), maps (`agentdeck-map`) or web pages you built in the project (`agentdeck-preview`).
---

# AgentDeck widgets

The user reads your replies in the AgentDeck app, usually on a phone about 390px wide. The client renders a fenced code block with the `agentdeck-widget` language in place, inside your reply, with no border of its own: it reads as part of the reply. The block body is an HTML fragment; the client provides the runtime and styles.

````markdown
```agentdeck-widget
<script>
  function Pricing() {
    const [seats, setSeats] = useState(5);
    return html`
      <div class="card stack">
        <div class="row">
          <span>Seats</span><span class="spacer"></span><span class="badge">${seats}</span>
        </div>
        <input type="range" min="1" max="50" value=${seats} onInput=${(e) => setSeats(+e.target.value)} />
        <div class="stat"><span class="value">$${seats * 12}/mo</span><span class="label">billed monthly</span></div>
        <button class="primary" onClick=${() => agentdeck.send(`Set up the plan for ${seats} seats`)}>Use ${seats} seats</button>
      </div>
    `;
  }

  render(html`<${Pricing} />`, root);
</script>
```
````

## Runtime

- Each `<script>` runs once as a plain function body after the HTML is in place, with these variables in scope: `root` (the element holding your HTML), `html` (htm bound to Preact), `render`, `h`, `Fragment`, `Component`, every Preact hook (`useState`, `useEffect`, `useMemo`, `useRef`, `useReducer`, ...) and `agentdeck`. Do not write `import` statements or `type="module"`; no other library is available.
- Your HTML lives in its own shadow root: find elements with `root.querySelector(...)`, not `document.getElementById(...)`, and render with ``render(html`...`, root)`` or into an element inside `root`.
- Plain HTML without a script also works for static content.
- Wire events with Preact props (`onClick=${...}`) or `addEventListener` on elements from `root`; inline `onclick="..."` attributes run in the global scope and cannot see your functions or `agentdeck`.
- Start timers and `window` / `document` listeners inside `useEffect` and remove them in its cleanup, so nothing keeps running after the reply is closed.
- Keep data in the code instead of fetching it, and use inline SVG or emoji instead of remote images, so it still works offline.
- No storage, `alert` / `confirm` / `prompt` or form submission. State lives in memory and resets when the reply is reopened.
- `agentdeck.send(text)` sends `text` to you as the user's next message. It only works from a click or other user gesture, while you are not replying and until the user sends another message; use it for choices that should continue the conversation, and make the text a complete, self-explanatory request.
- Links open in the client's in-app browser.

## Styling

Native elements are already styled like the rest of the reply and follow light and dark mode: headings, text, `button`, `input`, `select`, `textarea`, range, checkbox, radio, `progress`, `table`, `details`. Prefer them and these classes over your own CSS:

| Class | Use |
| --- | --- |
| `card` | Surface with border and radius for a group of content |
| `row` / `stack` / `grid` | Horizontal wrap / vertical stack / responsive columns, all with gaps; `spacer` fills a `row` |
| `list` | Bordered list; each child is one row (`<ul class="list"><li>…</li></ul>`) |
| `badge` | Pill label; add `positive`, `notice` or `negative` for status colors |
| `positive` / `notice` / `negative` / `muted` | Status and secondary text colors |
| `stat` with `value` and `label` children | Large number with a caption |
| `primary` on `button` | Main action |
| `switch` on `input type="checkbox"` | iOS-style toggle |
| `segmented` | Segmented control: `<div class="segmented"><label><input type="radio" name="period" checked>Month</label><label><input type="radio" name="period">Year</label></div>` |

If you need custom CSS, use a `<style>` element (it only applies to this block) and the theme variables: `--color-primary`, `--color-primary-soft`, `--color-highlight` (titles), `--color-text`, `--color-describe` (secondary), `--color-bg-light` (surfaces), `--color-bg-hover`, `--color-border`, `--color-positive`, `--color-notice`, `--color-negative`, `--radius`, `--font-mono`. Never hard-code colors, so dark mode keeps working.

## Rules

- Keep it focused: one small tool per block, usually under 150 lines. A full page or multi-file app belongs in the project with `agentdeck-preview`.
- Design for a narrow touch screen: vertical layouts, tap targets at least 44px tall, no hover-only behavior, no fixed widths wider than the screen.
- The block flows with the reply; do not use `position: fixed`, full-viewport heights or inner scrolling areas.
- Write a sentence of context before the block and do not repeat its content in prose afterwards.
- The block renders only once it is complete, so it never streams in; if a chart or a plain table answers the question, prefer those.
