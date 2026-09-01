import { type MarkedExtension, Renderer } from '@gem-bind/marked';

import '@gem-bind/latex';
import '@gem-bind/marked';
import '@gem-bind/mermaid';

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const languageFromInfo = (info = '') => {
  const token = info.trim().split(/\s+/)[0] || '';
  const cursorReference = /^\d+:\d+:(.+)$/.exec(token)?.[1];
  const pathReference = /^(?!\d+:\d+:)(.+):\d+:\d+$/.exec(token)?.[1];
  const filepath = cursorReference || pathReference;
  if (!filepath) return token.toLowerCase();
  const dot = filepath.lastIndexOf('.');
  return dot > 0 ? filepath.slice(dot + 1).toLowerCase() : '';
};

const blockLatex = {
  name: 'latexBlock',
  level: 'block' as const,
  start(source: string) {
    const match = /(?:^|\n)(?:\$\$|\\\[)/.exec(source);
    return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined;
  },
  tokenizer(source: string) {
    const match =
      /^\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(source) ||
      /^\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/.exec(source);
    if (match) return { type: 'latexBlock', raw: match[0], text: match[1].trim() };
    if (/^(?:\$\$|\\\[)/.test(source)) return { type: 'latexBlock', raw: source, text: '', pending: true };
  },
  renderer(token: { text: string; pending?: boolean }) {
    return token.pending ? '' : `<gem-bind-latex block tabindex="0">${escapeHtml(token.text)}</gem-bind-latex>\n`;
  },
};

const inlineLatex = {
  name: 'latexInline',
  level: 'inline' as const,
  start(source: string) {
    const indexes = [source.indexOf('$'), source.indexOf('\\(')].filter((index) => index >= 0);
    return indexes.length ? Math.min(...indexes) : undefined;
  },
  tokenizer(source: string) {
    const match =
      /^\$(?!\$|\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\$)/.exec(source) || /^\\\((?!\s)([^\n]*?)(?<!\s)\\\)/.exec(source);
    if (match?.[1]) return { type: 'latexInline', raw: match[0], text: match[1] };
  },
  renderer(token: { text: string }) {
    return `<gem-bind-latex>${escapeHtml(token.text)}</gem-bind-latex>`;
  },
};

const defaultRenderer = new Renderer();

export const markdownExtensions: MarkedExtension[] = [
  {
    gfm: true,
    breaks: true,
    extensions: [blockLatex, inlineLatex],
    renderer: {
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer"${title}>${label}</a>`;
      },
      code({ text, lang }) {
        const language = languageFromInfo(lang || '');
        const source = escapeHtml(text);
        if (language === 'mermaid') return `<gem-bind-mermaid tabindex="0">${source}</gem-bind-mermaid>`;
        if (['latex', 'tex', 'math'].includes(language)) {
          return `<gem-bind-latex block tabindex="0">${source}</gem-bind-latex>`;
        }
        return `<pre tabindex="0"><code data-language="${escapeHtml(language)}">${source}</code></pre>`;
      },
      table(token) {
        return `<div class="table-scroll" tabindex="0">${defaultRenderer.table.call(this, token)}</div>`;
      },
    },
  },
];

export const markdownStyle = new CSSStyleSheet();

markdownStyle.replaceSync(`
  :host {
    display: block;
    min-width: 0;
    color: inherit;
    font: inherit;
    line-height: 1.68;
    overflow-wrap: anywhere;
  }
  p { margin: 0; }
  p:not(:first-child) { margin-top: .48rem; }
  h1, h2, h3, h4, h5, h6 {
    margin: .85rem 0 .35rem;
    color: var(--color-highlight);
    font-family: var(--font-display);
    font-weight: 720;
    line-height: 1.3;
  }
  h1 { font-size: 1.28em; }
  h2 { font-size: 1.16em; }
  h3, h4, h5, h6 { font-size: 1.04em; }
  ul, ol { margin: .42rem 0; padding-left: 1.4rem; }
  li + li { margin-top: .18rem; }
  blockquote {
    margin: .65rem 0;
    border-left: 3px solid var(--color-primary);
    padding: .08rem 0 .08rem .8rem;
    color: var(--color-describe);
  }
  a { color: var(--color-primary-strong); text-underline-offset: 2px; }
  code {
    border-radius: 5px;
    background: var(--color-primary-soft);
    padding: .1em .32em;
    font-family: var(--font-mono);
    font-size: .9em;
  }
  pre {
    max-width: 100%;
    margin: .7rem 0;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-bg);
    padding: .85rem;
    color: var(--color-text);
    line-height: 1.55;
  }
  pre code { background: none; padding: 0; }
  pre:focus-visible, .table-scroll:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  .table-scroll {
    max-width: 100%;
    margin: .7rem 0;
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-bg);
  }
  table { width: 100%; border-collapse: collapse; font-size: .9em; }
  th, td { min-width: 7rem; padding: .55rem .7rem; vertical-align: top; }
  th { background: var(--color-bg-hover); color: var(--color-highlight); text-align: left; }
  tr + tr td, tbody td { border-top: 1px solid var(--color-border); }
  hr { margin: .9rem 0; border: 0; border-top: 1px solid var(--color-border); }
  img { max-width: 100%; height: auto; border-radius: 12px; }
  gem-bind-mermaid, gem-bind-latex { display: block; max-width: 100%; overflow: auto; }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: .01ms !important; }
  }
`);

export const userMarkdownStyle = new CSSStyleSheet();

userMarkdownStyle.replaceSync(`
  :host { display: block; min-width: 0; color: inherit; font: inherit; line-height: 1.55; overflow-wrap: anywhere; }
  p { margin: 0; }
  p:not(:first-child) { margin-top: .4rem; }
  ul, ol { margin: .35rem 0; padding-left: 1.3rem; }
  blockquote { margin: .5rem 0; border-left: 2px solid currentColor; padding-left: .65rem; opacity: .85; }
  a, a:visited { color: inherit; text-underline-offset: 2px; }
  code { border-radius: 4px; background: rgb(255 255 255 / .16); padding: .1em .3em; font-family: var(--font-mono); }
  pre { max-width: 100%; margin: .6rem 0; overflow: auto; border-radius: 9px; background: rgb(0 0 0 / .18); padding: .7rem; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgb(255 255 255 / .25); padding: .4rem; }
  img { max-width: 100%; border-radius: 9px; }
`);
