import { compressionImage } from '@mantou/tap-ui/lib/image';

import type { Attachment } from './session-runtime';

export const MAX_ATTACHMENTS = 10;
export const MAX_TEXT_BYTES = 256 * 1024;
const TEXT_EXTENSION =
  /\.(txt|md|markdown|json|jsonl|ndjson|csv|tsv|log|xml|svg|yaml|yml|toml|ini|cfg|conf|env|html?|css|scss|less|[jt]sx?|mjs|cjs|graphql|proto|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|r)$/i;

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
      throw new Error(`无法读取图片“${file.name}”，请重新选择有效的图片文件。`);
    }
  }
  const textFile =
    /^text\/|\b(?:json|xml|yaml|javascript|ecmascript|x-sh|sql|toml)\b/.test(file.type) ||
    (!file.type && TEXT_EXTENSION.test(file.name));
  if (!textFile) throw new Error(`暂不支持“${file.name}”，请选择图片或文本文件。`);
  if (file.size > MAX_TEXT_BYTES) throw new Error(`“${file.name}”超过 256 KB，请缩小文本文件后重试。`);
  try {
    return { ...base, kind: 'text', text: await file.text() };
  } catch {
    throw new Error(`无法读取“${file.name}”，请重新选择文件。`);
  }
};
