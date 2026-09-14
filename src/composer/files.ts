import { compressionImage } from '@mantou/tap-ui/lib/image';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import { i18n } from '../i18n';
import type { Attachment } from '../session/types';

export const MAX_ATTACHMENTS = 10;
export const MAX_TEXT_BYTES = 256 * 1024;
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
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = url;
  await image.decode();
  const previewUrl = await compressionImage(image, { dimension: { width: 1568, height: 1568 } }, { type: 'url' });
  const [header, data] = previewUrl.split(',');
  const mimeType = header.slice(5, header.indexOf(';'));
  return { data, mimeType, previewUrl };
};

export const readAttachment = async (file: File): Promise<Attachment> => {
  const base = { id: crypto.randomUUID(), name: file.name };
  if (file.type.startsWith('image/')) {
    try {
      return { ...base, kind: 'image', ...(await readImage(file)) };
    } catch {
      throw new Error(getStringFromTemplate(i18n.get('composer.attachmentImageFailed', file.name)));
    }
  }
  if (!(await isTextFile(file))) {
    throw new Error(getStringFromTemplate(i18n.get('composer.attachmentUnsupported', file.name)));
  }
  if (file.size > MAX_TEXT_BYTES) {
    throw new Error(getStringFromTemplate(i18n.get('composer.attachmentTooLarge', file.name)));
  }
  try {
    return { ...base, kind: 'text', text: await file.text() };
  } catch {
    throw new Error(getStringFromTemplate(i18n.get('composer.attachmentReadFailed', file.name)));
  }
};
