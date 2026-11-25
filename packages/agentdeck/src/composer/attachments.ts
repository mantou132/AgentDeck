import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import { AttachmentError } from 'src/attachment/read';
import type { Attachment } from 'src/attachment/types';
import { i18n } from 'src/i18n';

const attachmentErrorMessage = (error: unknown) =>
  error instanceof AttachmentError
    ? getStringFromTemplate(
        i18n.get(
          error.reason === 'tooLarge' ? 'composer.attachmentTooLarge' : 'composer.attachmentReadFailed',
          error.fileName,
        ),
      )
    : String(error);

export const readAttachments = async <T>(items: T[], reader: (item: T) => Promise<Attachment>) => {
  const results = await Promise.allSettled(items.map(reader));
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') attachments.push(result.value);
    else errors.push(attachmentErrorMessage(result.reason));
  }
  return { attachments, errors };
};
