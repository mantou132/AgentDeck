import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';

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

const unifiedDiff = ({ path, oldText, newText }: ToolCallDiff) => {
  const name = path || 'file';
  return [
    `diff --git ${name} ${name}`,
    createTwoFilesPatch(
      oldText == null ? '/dev/null' : name,
      newText == null ? '/dev/null' : name,
      oldText ?? '',
      newText ?? '',
      undefined,
      undefined,
      { context: 3, headerOptions: FILE_HEADERS_ONLY },
    ),
  ].join('\n');
};

export const toolCallDiffs = (content: unknown) => {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallDiff).map((diff) => ({ path: diff.path || 'file', text: unifiedDiff(diff) }));
};
