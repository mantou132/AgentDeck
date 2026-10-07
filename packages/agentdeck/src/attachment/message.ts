// Attachments carried by agent messages and session history. Shared with the extension, so names come from the caller.
import { Cache } from '@mantou/tap-ui/lib/cache';
import type { Attachment } from './types';

/** An ACP image content block. */
export const imageAttachment = (data: string, mimeType: string, name: string): Attachment => ({
  id: crypto.randomUUID(),
  kind: 'image',
  name,
  data,
  mimeType,
  previewUrl: `data:${mimeType};base64,${data}`,
});

// Inline base64 images are shown as attachments rather than links.
const dataImagePattern = /!?\[([^\]\n]*)\]\((data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)\)/gi;
// The daemon saves uploaded files under `agentdeck-attachments`; Claude replays them as `[@name](file://…)`.
const hostFilePattern = /\[@([^\]\n]+)\]\((file:\/\/[^)\s]*?[\\/]agentdeck-attachments[\\/][^)\s]+)\)/g;

type Extracted = { attachments: Attachment[]; markdown: string };

const cache = new Cache<Extracted>({ max: 100 });

/** Moves inline data images and uploaded host files out of message markdown into attachments. */
export const extractMessageAttachments = (text: string, imageName: string): Extracted => {
  if (!text.includes('data:image/') && !text.includes('agentdeck-attachments')) {
    return { attachments: [], markdown: text };
  }
  return cache.get(text, () => {
    const attachments: Attachment[] = [];
    const markdown = text
      .replace(dataImagePattern, (_, name: string, previewUrl: string) => {
        const [header, data = ''] = previewUrl.split(',');
        const mimeType = /^data:([^;]+);/.exec(header)?.[1] || 'image/png';
        attachments.push(imageAttachment(data, mimeType, name || imageName));
        return '';
      })
      .replace(hostFilePattern, (_, name: string, uri: string) => {
        attachments.push({ id: uri, kind: 'file', name, uri });
        return '';
      });
    return { attachments, markdown };
  });
};
