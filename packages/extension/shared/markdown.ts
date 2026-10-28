import type { MarkedExtension, Renderer, Tokens } from '@gem-bind/marked';

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Agent code reference fence info; codelang should extract the file extension:
// - Cursor: startLine:endLine:filepath
// - path:line:col (common in compilers/terminals, including file:/// absolute paths)
const CODE_REFERENCE_RE = /^(\d+):(\d+):(.+)$/;
const PATH_LOCATION_RE = /^(?!\d+:\d+:)(.+):(\d+):(\d+)$/;

const langFromFilepath = (filepath: string) => {
  const dot = filepath.lastIndexOf('.');
  return dot > 0 ? filepath.slice(dot + 1).toLowerCase() : '';
};

const resolveCodeLang = (lang = '') => {
  const token = lang.trim().split(/\s+/)[0];
  const ref = CODE_REFERENCE_RE.exec(token);
  if (ref) return langFromFilepath(ref[3]);
  const location = PATH_LOCATION_RE.exec(token);
  if (location) return langFromFilepath(location[1]);
  return token.toLowerCase();
};

const firstIndex = (...values: number[]) => {
  const indexes = values.filter((value) => value >= 0);
  return indexes.length ? Math.min(...indexes) : undefined;
};

const hasClosingFence = (raw?: string) => {
  if (!raw) return true;
  const [openingLine, ...lines] = raw.split(/\r?\n/);
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(openingLine)?.[1];
  if (!fence) return true;
  const closingFence = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
  return lines.some((line) => closingFence.test(line));
};

const blockLatex = {
  name: 'latexBlock',
  level: 'block' as const,
  start(source: string) {
    const match = /(?:^|\n)(?:\$\$|\\\[)/.exec(source);
    if (!match) return;
    return match.index + (match[0].startsWith('\n') ? 1 : 0);
  },
  tokenizer(source: string) {
    const dollar = /^\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(source);
    const bracket = /^\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/.exec(source);
    const match = dollar || bracket;
    if (match) return { type: 'latexBlock', raw: match[0], text: match[1].trim() };
    if (/^(?:\$\$|\\\[)/.test(source)) return { type: 'latexBlock', raw: source, text: '', pending: true };
  },
  renderer({ text, pending }: { text: string; pending?: boolean }) {
    if (pending) return '';
    return `<gem-bind-latex block tabindex="0">${escapeHtml(text)}</gem-bind-latex>\n`;
  },
};

const inlineLatex = {
  name: 'latexInline',
  level: 'inline' as const,
  start: (source: string) => firstIndex(source.indexOf('$'), source.indexOf('\\(')),
  tokenizer(source: string) {
    const dollar = /^\$(?!\$|\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\$)/.exec(source);
    const parenthesis = /^\\\((?!\s)([^\n]*?)(?<!\s)\\\)/.exec(source);
    const match = dollar || parenthesis;
    if (!match?.[1]) return;
    return { type: 'latexInline', raw: match[0], text: match[1] };
  },
  renderer({ text }: { text: string }) {
    return `<gem-bind-latex>${escapeHtml(text)}</gem-bind-latex>`;
  },
};

export const createMarkdownExtensions = (defaultMarkdownRenderer: Pick<Renderer, 'table'>): MarkedExtension[] => [
  {
    gfm: true,
    breaks: true,
    extensions: [blockLatex, inlineLatex],
    renderer: {
      link({ href, title, tokens }) {
        // TODO: Open local file in default editor
        const label = this.parser.parseInline(tokens);
        const titleAttribute = title ? `title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" ${titleAttribute}>${label}</a>`;
      },
      code({ text, lang, raw }) {
        const language = resolveCodeLang(lang);
        const source = escapeHtml(text);
        if (language === 'mermaid') return `<gem-bind-mermaid tabindex="0">${source}</gem-bind-mermaid>`;
        if (['latex', 'tex', 'math'].includes(language)) {
          return hasClosingFence(raw) ? `<gem-bind-latex block tabindex="0">${source}</gem-bind-latex>` : '';
        }
        return `<dy-code-block ${language ? `codelang="${escapeHtml(language)}"` : ''}>${source}</dy-code-block>`;
      },
      table(token: Tokens.Table) {
        const table = defaultMarkdownRenderer.table.call(this, token);
        return `<div class="table-scroll" tabindex="0">${table}</div>`;
      },
    },
  },
];
