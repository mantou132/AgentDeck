import { DATABASES } from '../config';
import { createDatabaseStore } from '../lib/database';
import type { Attachment, DeckSession } from '../session/types';

export type ComposerDraft = { text: string; attachments: Attachment[]; quote?: string };
const drafts = createDatabaseStore<ComposerDraft>(DATABASES.drafts);

export const draftKey = (session: DeckSession) =>
  session.pendingCreation ? JSON.stringify(['pending-session', session.agent, session.cwd]) : session.sessionId;

export const readDraft = drafts.get;
export const saveDraft = (key: string, draft: ComposerDraft) =>
  draft.text || draft.attachments.length || draft.quote ? drafts.set(key, draft) : drafts.delete(key);
export const restoreDraft = (key: string, draft: ComposerDraft) =>
  drafts.update(key, (existing) => existing ?? draft) as Promise<ComposerDraft>;
export const removeDraft = drafts.delete;
export const clearDrafts = drafts.clear;
