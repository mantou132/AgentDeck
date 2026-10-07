// Reads files picked or pasted in a composer. Shared with the extension, so errors carry a reason instead of app text.
import { arrayBufferToBase64 } from '@mantou/tap-ui/lib/encode';
import { compressionImage } from '@mantou/tap-ui/lib/image';
import type { Attachment } from './types';

export const MAX_ATTACHMENTS = 10;
export const MAX_TEXT_BYTES = 256 * 1024;
// Base64 grows by a third and the whole prompt must fit in one 10 MB Relay frame.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSION =
  /\.(txt|md|markdown|json|jsonl|ndjson|csv|tsv|log|xml|svg|yaml|yml|toml|ini|cfg|conf|env|html?|css|scss|less|[jt]sx?|mjs|cjs|graphql|proto|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|r|vue|svelte|astro|zig|nim|lua|dart|scala|ex|exs|erl|clj|hs|elm|diff|patch|lock|properties|mod|sum)$/i;

const isBinaryBuffer = (buffer: ArrayBuffer): boolean => {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
};

const isTextFile = async (file: File): Promise<boolean> => {
  if (
    /^text\/|\b(?:json|xml|yaml|javascript|typescript|ecmascript|x-sh|sql|toml)\b/i.test(file.type) ||
    TEXT_EXTENSION.test(file.name)
  ) {
    return true;
  }
  try {
    const chunk = await file.slice(0, 4096).arrayBuffer();
    return !isBinaryBuffer(chunk);
  } catch {
    return false;
  }
};

const readImage = async (file: File) => {
  const previewUrl = await compressionImage(file, { dimension: { width: 1568, height: 1568 } }, { type: 'url' });
  const [header, data] = previewUrl.split(',');
  return { data, mimeType: header.slice(5, header.indexOf(';')), previewUrl };
};

export class AttachmentError extends Error {
  constructor(
    readonly reason: 'tooLarge' | 'readFailed',
    readonly fileName: string,
  ) {
    super(`${reason}: ${fileName}`);
  }
}

/** Images and small text files are inlined; anything else is saved on the host for the agent to read. */
export const readAttachment = async (file: File): Promise<Attachment> => {
  const base = { id: crypto.randomUUID(), name: file.name };
  if (file.type.startsWith('image/')) {
    try {
      return { ...base, kind: 'image', ...(await readImage(file)) };
    } catch {
      // Formats the WebView cannot decode (e.g. HEIC) go to the host as files.
    }
  }
  if (file.size > MAX_FILE_BYTES) throw new AttachmentError('tooLarge', file.name);
  const isText = file.size <= MAX_TEXT_BYTES && (await isTextFile(file));
  try {
    return isText
      ? { ...base, kind: 'text', text: await file.text() }
      : { ...base, kind: 'file', mimeType: file.type, data: arrayBufferToBase64(await file.arrayBuffer()) };
  } catch {
    throw new AttachmentError('readFailed', file.name);
  }
};
