import { type MarkedExtension, Renderer } from '@gem-bind/marked';
import { agentDeckTheme } from '../styles/theme';
import { diffColorScheme } from './diff';
import { isSmallTextFile } from './file-preview';
import { parseMessageLink } from './links';
import { isAbsoluteHostPath, previewSupported, toPreviewUrl } from './preview';

import '../elements/chart';
import '../elements/preview';
import '../elements/screen';

// Heavy elements stay out of the initial bundle; markup rendered earlier upgrades once they define themselves.
import('@gem-bind/diff2html');
import('@gem-bind/latex');
import('@gem-bind/mermaid');

export const escapeHtml = (value: string) =>
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
      /^\$(?!\$|\s)((?:\\.|[^$\n])+?)(?<!\s)\$(?!\$)/.exec(source) ||
      /^\x5c\((?!\s)([^\n]*?)(?<!\s)\x5c\)/.exec(source);
    if (match?.[1]) return { type: 'latexInline', raw: match[0], text: match[1] };
  },
  renderer(token: { text: string }) {
    return `<gem-bind-latex>${escapeHtml(token.text)}</gem-bind-latex>`;
  },
};

const defaultRenderer = new Renderer();
const diffLanguages = ['diff', 'patch', 'udiff', 'unified-diff'];

export const isCodeBlockClosed = (raw = '') => {
  const match = /^[ \t]*(`{3,}|~{3,})/.exec(raw);
  if (!match) return true;
  const fence = match[1];
  const fenceChar = fence[0];
  const fenceLen = fence.length;
  return new RegExp(`\\n[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*\\n?$`).test(raw);
};

/** `baseDir` resolves relative images, e.g. the session cwd or a Markdown file's own directory. */
type MarkdownOptions = { codeBlock?: boolean; foldCode?: boolean; baseDir?: string };

/** Host path of an image source, loaded through the preview protocol. */
const hostImagePath = (src: string, baseDir?: string) => {
  const link = parseMessageLink(src);
  if (link?.type !== 'file') return;
  if (isAbsoluteHostPath(link.path)) return link.path;
  if (baseDir) return `${baseDir.replace(/[\\/]?$/, '/')}${link.path.replace(/^\.[\\/]/, '')}`;
};

const createMarkdownExtensions = (options: MarkdownOptions = {}): MarkedExtension[] => [
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
      code({ text, lang, raw }) {
        const language = languageFromInfo(lang || '');
        const source = escapeHtml(text);
        const closed = isCodeBlockClosed(raw);
        if (closed && language === 'mermaid')
          return `<gem-bind-mermaid no-controls tabindex="0">${source}</gem-bind-mermaid>`;
        if (closed && language === 'agentdeck-chart') return `<deck-chart source="${source}"></deck-chart>`;
        if (closed && language === 'agentdeck-preview') return `<deck-preview path="${source}"></deck-preview>`;
        if (closed && language === 'agentdeck-screen') return `<deck-screen target="${source}"></deck-screen>`;
        if (closed && diffLanguages.includes(language)) {
          return `<gem-bind-diff2html color-scheme="${diffColorScheme}" compact-line-numbers tabindex="0">${source}</gem-bind-diff2html>`;
        }
        if (closed && ['latex', 'tex', 'math'].includes(language)) {
          return `<gem-bind-latex block tabindex="0">${source}</gem-bind-latex>`;
        }
        const block =
          closed && options.codeBlock && isSmallTextFile(text)
            ? `<tap-code-block codelang="${escapeHtml(language)}" tabindex="0">${source}</tap-code-block>`
            : `<pre tabindex="0"><code data-language="${escapeHtml(language)}">${source}</code></pre>`;
        if (closed && options.foldCode)
          return `<deck-foldable codelang="${escapeHtml(language)}">${block}</deck-foldable>`;
        return block;
      },
      // Host images (e.g. screenshots taken by the agent) load through the preview protocol.
      image(token) {
        const path = previewSupported ? hostImagePath(token.href, options.baseDir) : undefined;
        return defaultRenderer.image.call(this, { ...token, href: path ? toPreviewUrl(path) : token.href });
      },
      table(token) {
        return `<div class="table-scroll" tabindex="0">${defaultRenderer.table.call(this, token)}</div>`;
      },
    },
  },
];

/** Extensions by `baseDir`, cached so the same directory keeps the same parser. */
const extensionsFor = (options: Omit<MarkdownOptions, 'baseDir'>) => {
  const cache = new Map<string, MarkedExtension[]>();
  return (baseDir = '') => {
    let extensions = cache.get(baseDir);
    if (!extensions) {
      extensions = createMarkdownExtensions({ ...options, baseDir });
      cache.set(baseDir, extensions);
    }
    return extensions;
  };
};

export const markdownExtensions = extensionsFor({ codeBlock: true, foldCode: true });
export const unfoldedMarkdownExtensions = extensionsFor({ codeBlock: true });
export const userMarkdownExtensions = extensionsFor({ codeBlock: false });

const baseMarkdownStyle = `
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
    color: ${agentDeckTheme.highlightColor};
    font-family: ${agentDeckTheme.displayFont};
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
    border-left: 3px solid ${agentDeckTheme.primaryColor};
    padding: .08rem 0 .08rem .8rem;
    color: ${agentDeckTheme.describeColor};
  }
  a { color: ${agentDeckTheme.primaryStrongColor}; text-underline-offset: 2px; }
  code {
    border-radius: 5px;
    background: ${agentDeckTheme.primarySoftColor};
    padding: .1em .32em;
    font-family: ${agentDeckTheme.codeFont};
    font-size: .9em;
  }
  pre,
  tap-code-block,
  gem-bind-mermaid,
  .table-scroll,
  deck-chart,
  deck-preview,
  deck-screen {
    border: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
    border-radius: ${agentDeckTheme.normalRound};
    background: ${agentDeckTheme.lightBackgroundColor};
    max-width: 100%;
    margin: .7rem 0;
    outline: none;
  }
  pre, tap-code-block {
    color: ${agentDeckTheme.textColor};
    line-height: 1.55;
  }
  pre {
    overflow: auto;
    padding: .85rem;
  }
  tap-code-block {
    overflow: hidden;
  }
  pre code { background: none; padding: 0; }
  deck-foldable { margin: .7rem 0; }
  deck-foldable > :is(pre, tap-code-block) { margin: 0; }
  .table-scroll {
    overflow-x: auto;
  }
  /* WebKit 的 collapse 模式不绘制小于 1px 的单元格边框 */
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: .9em; }
  th, td { min-width: 7rem; padding: .55rem .7rem; vertical-align: top; }
  th { background: ${agentDeckTheme.hoverBackgroundColor}; color: ${agentDeckTheme.highlightColor}; text-align: left; }
  tr + tr td, tbody td { border-top: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor}; }
  hr { margin: .9rem 0; border: 0; border-top: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor}; }
  img { max-width: 100%; height: auto; border-radius: ${agentDeckTheme.normalRound}; }
  gem-bind-diff2html {
    margin: .7rem 0;
    border-radius: ${agentDeckTheme.normalRound};
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: .01ms !important; }
  }
`;

export const markdownStyle = new CSSStyleSheet();
markdownStyle.replaceSync(baseMarkdownStyle);

export const fileViewerMarkdownStyle = new CSSStyleSheet();
fileViewerMarkdownStyle.replaceSync(`
  ${baseMarkdownStyle}
  ${
    // Without the preview protocol, local images would resolve against the client's own URL.
    previewSupported ? '' : `:where(img, video)[src]:not([src^="http"]):not([src^="//"]) { display: none; }`
  }
`);

export const userMarkdownStyle = new CSSStyleSheet();

userMarkdownStyle.replaceSync(`
  :host { display: block; min-width: 0; color: inherit; font: inherit; line-height: 1.55; overflow-wrap: anywhere; }
  p { margin: 0; }
  p:not(:first-child) { margin-top: .4rem; }
  ul, ol { margin: .35rem 0; padding-left: 1.3rem; }
  blockquote { margin: .5rem 0; border-left: 2px solid currentColor; padding-left: .65rem; opacity: .85; }
  a, a:visited { color: ${agentDeckTheme.primaryStrongColor}; text-underline-offset: 2px; }
  code { border-radius: ${agentDeckTheme.smallRound}; background: ${agentDeckTheme.lightBackgroundColor}; padding: .1em .3em; font-family: ${agentDeckTheme.codeFont}; }
  pre,
  gem-bind-mermaid,
  .table-scroll,
  deck-chart,
  deck-preview,
  deck-screen {
    max-width: 100%;
    margin: .6rem 0;
    border: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
    border-radius: 9px;
    background: ${agentDeckTheme.lightBackgroundColor};
    outline: none;
  }
  pre { overflow: auto; padding: .7rem; }
  pre code { background: none; padding: 0; }
  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor}; padding: .4rem; }
  img { max-width: 100%; border-radius: 9px; }
  gem-bind-diff2html { display: block; max-width: 100%; overflow: auto; border-radius: 9px; }
`);
