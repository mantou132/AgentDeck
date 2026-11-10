// Content shared from other apps (Android `MainActivity.kt`, iOS share extension); the session list opens a new session with it.
import { Toast } from '@mantou/tap-ui/elements/toast';
import { base64ToArrayBuffer } from '@mantou/tap-ui/lib/encode';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { AttachmentError, MAX_ATTACHMENTS, readAttachment } from '../attachment/read';
import type { Attachment } from '../attachment/types';
import { attachmentErrorMessage } from '../elements/composer';
import { i18n } from '../i18n';

type SharedFile = { name: string; mimeType: string; data?: string; tooLarge: boolean };

/** Attachments waiting for the user to pick the new session's directory. */
export const shareStore = createStore({ attachments: [] as Attachment[] });

export const clearShare = () => shareStore({ attachments: [] });

const readSharedFile = async ({ name, mimeType, data, tooLarge }: SharedFile) => {
  if (!data) throw new AttachmentError(tooLarge ? 'tooLarge' : 'readFailed', name);
  return readAttachment(new File([base64ToArrayBuffer(data)], name, { type: mimeType }));
};

const takeShare = async () => {
  const files = await invoke<SharedFile[]>('share_take');
  if (!files.length) return;
  const results = await Promise.allSettled(files.map(readSharedFile));
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') attachments.push(result.value);
    else errors.push(attachmentErrorMessage(result.reason));
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    attachments.length = MAX_ATTACHMENTS;
    errors.push(i18n.get('composer.maxAttachments'));
  }
  if (errors.length) Toast.open('error', errors.join('\n'));
  // A new share replaces one still waiting for a directory.
  if (attachments.length) shareStore({ attachments });
};

export const startShareTarget = () => {
  if (!isTauri()) return;
  const take = () => takeShare().catch(console.error);
  // Android dispatches this once the share is copied; the iOS extension finishes writing before it opens the app.
  addEventListener('agentdeck-share', take);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') take();
  });
  take();
};
