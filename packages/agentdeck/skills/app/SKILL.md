---
name: app
description: Build a small mobile web app the user can open and use in the AgentDeck client. Use when the user asks to make an app, tool, tracker, mini game or other interactive screen for their phone, beyond what a one-off widget can hold; copy the bundled Gem + Tap UI template next to this file, build it to static files and answer with an `agentdeck-app` block holding the absolute path of `dist/index.html`.
---

# AgentDeck apps

The user reads your replies in the AgentDeck app, usually on a phone away from this machine. A page you build here opens full screen in the client, served read-only from this machine's files. Start from the `template` directory next to this file: the same stack as AgentDeck's own client (Gem web components, Tap UI mobile components, Tailwind, Rsbuild), already set up for phone screens, safe areas and page navigation.

## Workflow

1. Copy the whole `template` directory (it includes a `.gitignore`) to a new directory in the working directory named after the app, e.g. `cp -R <this skill>/template ./habit-tracker`. Never edit the template in place: it is rewritten whenever agentdeckd restarts. If the user points at an app made earlier, keep working in that one.
2. In a new app, fill `public/agentdeck.json`: `id` is 12 random lowercase letters and digits, starting with a letter (e.g. `k3m9q2xv7a1p`), set once and never changed, since it names the copy saved on the phone and its data; `name` is a short app name shown under the home screen icon. Replace `public/icon.svg` with an icon for the app: square, filled to the edges (the phone rounds or crops the corners, so keep the main shape within the center two thirds), no text.
3. Install dependencies with the package manager available (`pnpm install`, else `npm install`).
4. Replace the example (`src/store.ts`, `src/elements/*`) with the app, keeping `src/sheet.ts`. Run `npm run build` (it also generates `src/auto-import.d.ts`), then `npx tsc -p .`, and fix every error.
5. Reply with a short note on what to try and the app block (absolute path). The user can preview it from this machine, or save it on the phone to use without this machine:

````markdown
```agentdeck-app
/Users/me/project/habit-tracker/dist/index.html
```
````

After each change, rebuild and send the block again; a copy saved on the phone changes only when the user saves it again from the new block.

## Limits

- Only static files are served: no dev server, backend or server-side routing. Keep data on the device with `localStorage` or IndexedDB. Network requests go out from the phone, so only public APIs that allow CORS work.
- External resources (CDN scripts, fonts, images) load from the phone's network; prefer npm packages bundled by the build.
- Each built file must stay under about 5 MB.

## Project layout

- `src/main.ts` calls Tap UI's `initApp`, which renders the root page `<app-home>` into the global Stack; keep its `onRootClose`, which takes the app saved on the phone back to AgentDeck. Open more pages with `Stack.push({ content: html`<app-xxx .prop=${value}></app-xxx>` })` and go back with `Stack.pop()` or `<tap-navbar back default-back>`; pushed pages close with the edge swipe. For tabs, keep one root page with a `<tap-tabbar slot="footer">` and switch its content.
- `src/elements/<name>.ts` defines `<app-<name>>`. `unplugin-gem` auto-imports Gem APIs (`html`, `css`, `createStore`, decorators …), Tap UI elements (`<tap-*>`) and project elements (`<app-*>`) used in templates; import other things, such as `Stack` or `Toast`, explicitly.
- `src/sheet.ts`: `const close = openSheet({ header, body: html`<app-xxx @done=${() => close()}></app-xxx>` })` opens a bottom sheet above all pages (see `src/elements/home.ts`). Use it instead of `Sheet.open`, and pass only strings to `Dialog.open`: both render their body inside a shadow root, where Tailwind classes and the styles of `app-*` elements don't apply. `ActionSheet.open` and `Toast.open` are fine.
- `src/tailwind.css` holds the colors (light and dark through `light-dark()`) and replaces Tailwind's preflight with a reset that skips Gem elements; don't import `tailwindcss/preflight`, it strips the padding of Tap UI elements. `src/theme.ts` passes the colors to Tap UI.
- Tap UI's own texts (empty state, cancel …) are English; for another language add `loadLocale(import('@mantou/tap-ui/locales/zh'))` (from `@mantou/tap-ui/lib/locale`) to `main.ts`.

## Gem

Read `node_modules/@mantou/gem/AGENTS.md` before writing elements; it is the full guide, with an annotated example. In short:

- ES decorators and `#` private fields; `@template()` renders, `@effect` / `@memo` / `@mounted` replace lifecycle methods (`connectedCallback`, `render()`); no manual `customElements.define`.
- Inputs are `@attribute` / `@numattribute` / `@boolattribute` (no default values; use getters) and `@property`; never assign them from inside the element. Internal data goes in `createState`, shared data in `createStore` with `@connectStore`; events are `@emitter`.
- Templates are lit-html plus `v-if` / `v-else-if` / `v-else`; use `classMap` / `styleMap` instead of inline styles. Elements are Light DOM by default: style them with Tailwind utilities, or `css` + `@adoptedStyle` using `:scope`.

## Tap UI

Elements live in `node_modules/@mantou/tap-ui/elements/`; read the `.d.ts` of the element you use for its properties and events instead of guessing. Common ones: `tap-page`, `tap-navbar`, `tap-tabbar`, `tap-button`, `tap-cell-group` (lists and settings rows via `.items`; set `action: false` on rows that don't navigate, or they show a chevron), `tap-input`, `tap-switch`, `tap-checkbox`, `tap-radio`, `tap-select`, `tap-segmented`, `tap-stepper`, `tap-slider`, `tap-date-picker`, `tap-searchbar`, `tap-swipeout`, `tap-card`, `tap-empty`, `tap-badge`, `tap-tag`, `tap-carousel`. Navbar actions are `<tap-use slot="right" role="button" aria-label="…" .element=${icon}>` with an SVG string icon. Imperative APIs: `Toast.open('success', 'Saved')` (keep messages short), `ActionSheet.open` for choices and confirmations.
