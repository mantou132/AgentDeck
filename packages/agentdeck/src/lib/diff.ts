import { structuredPatch } from 'diff';

export const diffColorScheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';

export type ToolCallDiff = {
  type: 'diff';
  path?: string;
  oldText?: string | null;
  newText?: string | null;
};

const isToolCallDiff = (value: unknown): value is ToolCallDiff => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'diff' &&
    (item.path === undefined || typeof item.path === 'string') &&
    (item.oldText === undefined || item.oldText === null || typeof item.oldText === 'string') &&
    (item.newText === undefined || item.newText === null || typeof item.newText === 'string')
  );
};

// Tool diffs only carry snippets, so hunk headers and line numbers would be misleading; keep +/- lines only.
const snippetDiff = ({ oldText, newText }: ToolCallDiff) =>
  structuredPatch('', '', oldText ?? '', newText ?? '', undefined, undefined, { context: 3 })
    .hunks.map(({ lines }) => lines.filter((line) => !line.startsWith('\\')).join('\n'))
    .join('\n…\n');

export const toolCallDiffs = (content: unknown) => {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallDiff).map((diff) => ({ path: diff.path || 'file', text: snippetDiff(diff) }));
};
