// Converts attachments to the `agent_prompt` wire format. Shared with the extension.
import type { PromptAttachment } from '../agent/api';
import type { Attachment } from './types';

export const toPromptAttachment = (attachment: Attachment): PromptAttachment => {
  const { name } = attachment;
  switch (attachment.kind) {
    case 'image':
      return { type: 'image', data: attachment.data, mimeType: attachment.mimeType };
    case 'text': {
      const escaped = name.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
      return { type: 'text', text: `<attachment name="${escaped}">\n${attachment.text}\n</attachment>` };
    }
    case 'file':
      return 'uri' in attachment
        ? { type: 'resource', uri: attachment.uri, name }
        : { type: 'file', name, data: attachment.data, mimeType: attachment.mimeType };
  }
};
