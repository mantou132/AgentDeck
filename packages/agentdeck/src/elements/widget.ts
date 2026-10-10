import type { Emitter } from '@mantou/gem/lib/decorators';
import { html as htm } from 'htm/preact';
import { Component, type ComponentChildren, Fragment, h, render } from 'preact';
import * as hooks from 'preact/hooks';
import { i18n } from '../i18n';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

/**
 * Native elements match the reply's Markdown; classes cover controls HTML lacks. Theme variables inherit from the
 * document. Taught by the host's `widget` skill, so keep both in sync.
 */
const kitStyle = css`
  :host {
    display: block;
  }
  .root {
    --radius: 12px;
    --hairline: ${agentDeckTheme.borderWidth};
    display: flow-root;
    overflow-wrap: anywhere;
    -webkit-tap-highlight-color: transparent;
  }
  .root > :first-child { margin-top: 0; }
  .root > :last-child { margin-bottom: 0; }
  h1, h2, h3, h4 {
    margin: .85rem 0 .35rem;
    color: var(--color-highlight);
    font-family: var(--font-display);
    font-weight: 720;
    line-height: 1.3;
  }
  h1 { font-size: 1.28em; }
  h2 { font-size: 1.16em; }
  h3, h4 { font-size: 1.04em; }
  p { margin: .48rem 0; }
  a { color: var(--color-primary-strong); text-underline-offset: 2px; }
  small, .muted { color: var(--color-describe); font-size: var(--text-xs); }
  code { border-radius: 5px; background: color-mix(in srgb, currentColor 7%, transparent); padding: .1em .32em; font: .9em var(--font-mono); }
  hr { margin: .9rem 0; border: 0; border-top: var(--hairline) solid var(--color-border); }
  img, svg, canvas, video { max-width: 100%; }
  button, input, select, textarea { font: inherit; color: inherit; }
  /* Matches the app's own controls: secondary buttons like the session page's, fields and primary buttons like settings. */
  button {
    min-height: 2.75rem;
    padding: .5rem 1rem;
    border: 0;
    border-radius: var(--radius);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 1.3;
    cursor: pointer;
    touch-action: manipulation;
    transition: transform .15s, opacity .15s;
  }
  button:active { transform: scale(.97); opacity: .85; }
  button:disabled { opacity: .45; pointer-events: none; }
  button.primary { background: var(--color-primary); color: #fff; }
  input:not([type=checkbox], [type=radio], [type=range], [type=color]), select, textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 3rem;
    padding: .5rem .875rem;
    border: var(--hairline) solid var(--color-border-strong);
    border-radius: var(--radius);
    background: var(--color-bg-light);
    color: var(--color-highlight);
    font-size: var(--text-base);
    outline: none;
  }
  /* Inside a surface, fields drop to the page background, as in settings. */
  :is(.card, .list) :is(input, select, textarea) { background-color: var(--color-bg); }
  ::placeholder { color: var(--color-disabled); }
  select {
    appearance: none;
    padding-right: 2.75rem;
    font-weight: 500;
    /* The settings chevron (icons.expand) in the theme's describe colors. */
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23767a91' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right .875rem center;
    background-size: 1rem;
  }
  @media (prefers-color-scheme: dark) {
    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a0a4ad' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    }
  }
  textarea { min-height: 5rem; resize: vertical; }
  :is(input, select, textarea):focus-visible { border-color: var(--color-focus); box-shadow: 0 0 0 3px var(--color-primary-soft); }
  input, progress, meter { accent-color: var(--color-primary); }
  input[type=range], progress, meter { width: 100%; }
  label { cursor: pointer; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: .9em; }
  th, td { padding: .55rem .7rem; text-align: left; vertical-align: top; }
  th { background: var(--color-bg-hover); color: var(--color-highlight); }
  tbody td, tr + tr td { border-top: var(--hairline) solid var(--color-border); }
  details { margin: .5rem 0; }
  summary { cursor: pointer; color: var(--color-highlight); font-weight: 600; }

  .card {
    margin: .7rem 0;
    padding: 1rem;
    border: var(--hairline) solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-bg-light);
  }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
  .stack { display: grid; gap: .75rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem; }
  .spacer { flex: 1; }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: .05rem .55rem;
    border-radius: 999px;
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 1.6;
  }
  .badge:is(.positive, .notice, .negative) { background: color-mix(in srgb, currentColor 14%, transparent); }
  .positive { color: var(--color-positive); }
  .notice { color: var(--color-notice); }
  .negative { color: var(--color-negative); }
  .stat { display: grid; gap: .1rem; }
  .stat .value { color: var(--color-highlight); font: 720 1.6em/1.2 var(--font-display); }
  .stat .label { color: var(--color-describe); font-size: var(--text-xs); }
  .list {
    margin: .7rem 0;
    padding: 0;
    border: var(--hairline) solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-bg-light);
    list-style: none;
    overflow: hidden;
  }
  /* Wraps so a long description drops below instead of squeezing the row. */
  .list > * { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; min-height: 3rem; padding: .6rem 1rem; }
  .list > * + * { border-top: var(--hairline) solid var(--color-border); }
  input[type=checkbox].switch {
    appearance: none;
    position: relative;
    flex-shrink: 0;
    width: 51px;
    height: 31px;
    margin: 0;
    border-radius: 999px;
    background: var(--color-border-strong);
    cursor: pointer;
    transition: background-color .2s;
  }
  input[type=checkbox].switch::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 6px rgb(0 0 0 / .2);
    transition: transform .2s;
  }
  input[type=checkbox].switch:checked { background: var(--color-primary); }
  input[type=checkbox].switch:checked::before { transform: translateX(20px); }
  .segmented { display: flex; padding: 2px; border-radius: 10px; background: var(--color-bg-hover); }
  .segmented > label {
    position: relative;
    flex: 1;
    padding: .3rem .5rem;
    border-radius: 8px;
    color: var(--color-describe);
    font-size: var(--text-sm);
    font-weight: 600;
    text-align: center;
    transition: background-color .15s;
  }
  .segmented input { position: absolute; opacity: 0; pointer-events: none; }
  .segmented > label:has(input:checked) {
    background: var(--color-bg-light);
    color: var(--color-highlight);
    box-shadow: 0 1px 4px rgb(0 0 0 / .12);
  }
  /* Like iOS, the dark selection is lighter than its track. */
  @media (prefers-color-scheme: dark) {
    .segmented > label:has(input:checked) { background: var(--color-border-strong); }
  }

  .status {
    display: flex;
    align-items: center;
    gap: .5rem;
    color: var(--color-describe);
    font-size: var(--text-sm);
  }
  .status tap-use { flex-shrink: 0; width: 1.125rem; }
  .status.error { color: var(--color-negative); }
  .error-detail summary {
    color: var(--color-describe);
    font-size: var(--text-xs);
    font-weight: normal;
  }
  .source {
    margin: .5rem 0 0;
    padding: .75rem;
    overflow: auto;
    border-radius: ${agentDeckTheme.smallRound};
    background: var(--color-bg-light);
    font: var(--text-xs) var(--font-mono);
  }
  @media (prefers-reduced-motion: reduce) {
    *, ::before, ::after { transition-duration: .01ms !important; animation-duration: .01ms !important; }
  }
`;

/** Agents trained on ES modules may still import the runtime they are handed as parameters. */
const RUNTIME_IMPORT = /^\s*import\s[\s\S]*?\bfrom\s*['"](?:preact|preact\/hooks|htm|htm\/preact)['"];?/gm;

type ErrorBoundaryProps = { onError: (error: unknown) => void; children?: ComponentChildren };

/** Render and lifecycle errors stay inside their block instead of escaping to the page. */
const ErrorBoundary = ({ onError, children }: ErrorBoundaryProps) => {
  hooks.useErrorBoundary(onError);
  return h(Fragment, null, children);
};

/**
 * An `agentdeck-widget` block: the agent's HTML and scripts, rendered in place and blended into the reply.
 * Agent output is trusted like the host it already controls; the shadow root only keeps styles and lookups local.
 * `pending` marks a block still streaming in, which shows progress instead of half-written code.
 */
@customElement('deck-widget')
@adoptedStyle(kitStyle)
@shadow()
export class DeckWidgetElement extends GemElement {
  @attribute source: string;
  @boolattribute pending: boolean;
  /** Text the user sent from the widget, for the session page to submit as a prompt. */
  @globalemitter widgetSend: Emitter<string>;

  #rootRef = createRef<HTMLDivElement>();
  #state = createState({ error: '' });

  #fail = (error: unknown) => {
    console.error(error);
    this.#state({ error: String((error as Error)?.message || error) });
  };

  /** Only from a user gesture, so a buggy widget cannot loop prompts. */
  #send = (text: unknown) => {
    const value = String(text ?? '').trim();
    if (!value || navigator.userActivation?.isActive === false) return false;
    this.widgetSend(value);
    return true;
  };

  @effect((i) => [i.source, i.pending])
  #run = () => {
    const root = this.#rootRef.value;
    if (this.pending || !root) return;
    this.#state({ error: '' });
    const parsed = document.createElement('template');
    parsed.innerHTML = this.source;
    const scripts = [...parsed.content.querySelectorAll('script')];
    for (const script of scripts) script.remove();
    root.replaceChildren(parsed.content);

    const containers = new Set<Element | DocumentFragment>();
    const scopedRender = (vnode: ComponentChildren, parent: Element | DocumentFragment) => {
      containers.add(parent);
      render(h(ErrorBoundary, { onError: this.#fail }, vnode), parent);
    };
    const scope = {
      root,
      html: htm,
      render: scopedRender,
      h,
      Fragment,
      Component,
      ...hooks,
      agentdeck: Object.freeze({ send: this.#send }),
    };
    for (const script of scripts) {
      try {
        new Function(...Object.keys(scope), script.textContent.replace(RUNTIME_IMPORT, ''))(...Object.values(scope));
      } catch (error) {
        this.#fail(error);
      }
    }
    return () => {
      for (const container of containers) render(null, container);
      root.replaceChildren();
    };
  };

  @template((i) => i.pending)
  #renderPending = () => html`
    <div class="status">
      <tap-use .element=${icons.loading}></tap-use>
      ${i18n.get('widget.generating')}
    </div>
  `;

  @template()
  #render = () => {
    const { error } = this.#state;
    return html`
      <div class="root" ${this.#rootRef} @submit=${(event: Event) => event.preventDefault()}></div>
      <div v-if=${!!error}>
        <div class="status error">
          <tap-use .element=${icons.error}></tap-use>
          ${i18n.get('widget.failed')}
        </div>
        <details class="error-detail">
          <summary>${error}</summary>
          <pre class="source">${this.source}</pre>
        </details>
      </div>
    `;
  };
}
