import type { Emitter } from '@mantou/gem/lib/decorators';
import { Toast } from '@mantou/tap-ui/elements/toast';
import { longPress } from '@mantou/tap-ui/lib/directives';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import type { AvailableCommand } from '../agent/api';
import { AttachmentError, MAX_ATTACHMENTS, MAX_TEXT_BYTES, readAttachment } from '../attachment/read';
import type { Attachment } from '../attachment/types';
import { readDraft, saveDraft } from '../composer/drafts';
import {
  createPasteReference,
  expandReferenceRange,
  LONG_PASTE_CHAR_THRESHOLD,
  syncPasteReferences,
} from '../composer/references';
import { i18n } from '../i18n';
import { hapticSelection } from '../lib/haptics';
import { ensureRecognitionPermission, speechSupported, startRecognitionSession } from '../lib/speech-recognition';
import { icons } from '../styles/icons';

export type ComposerInput = { text: string; attachments: Attachment[]; voiceChat?: boolean };
type InputSelection = { input: string; start: number; end: number };
const style = css`
  .composer-shell {
    padding-bottom: calc(6px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
  .composer-surface {
    border-radius: 26px;
  }
  @supports (corner-shape: squircle) {
    .composer-surface {
      border-radius: 32px;
      corner-shape: squircle;
    }
  }
`;

const attachmentErrorMessage = (error: unknown) =>
  error instanceof AttachmentError
    ? getStringFromTemplate(
        i18n.get(
          error.reason === 'tooLarge' ? 'composer.attachmentTooLarge' : 'composer.attachmentReadFailed',
          error.fileName,
        ),
      )
    : String(error);

@customElement('deck-composer')
@adoptedStyle(style)
@adoptedStyle(blockContainer)
export class DeckComposerElement extends GemElement {
  @property sessionKey = '';
  @property draftKey = '';
  @attribute configLabel: string;
  @emitter configOpen: Emitter;
  @property placeholder = '';
  /** Predicted next prompt: replaces the placeholder while the input is empty, can be sent as is, long press fills it in. */
  @property suggestion = '';
  /** Slash commands offered while the input is a single `/word`. */
  @property commands: AvailableCommand[] = [];
  @property submit?: (input: ComposerInput) => boolean | Promise<boolean>;
  @boolattribute disabled: boolean;
  @boolattribute ready: boolean;
  @boolattribute pending: boolean;
  @emitter cancel: Emitter;
  @emitter preview: Emitter<Attachment>;
  @emitter draftChange: Emitter;
  /** Send button with nothing to send opens voice chat instead. */
  @emitter voiceChat: Emitter;

  #state = createState({
    draft: '',
    quote: '',
    attachments: [] as Attachment[],
    readingAttachments: false,
    submitting: false,
    loadingDraft: false,
    dictating: false,
  });
  #textareaRef = createRef<HTMLTextAreaElement>();
  #fileInputRef = createRef<HTMLInputElement>();
  #nextPasteReference = 1;
  #pastedAttachments = new Map<string, Attachment>();
  #stopDictationSession?: () => void;

  @effect((i) => [i.sessionKey, i.draftKey])
  #resetInput = async () => {
    this.#clearInput();
    this.#state({ loadingDraft: Boolean(this.draftKey), readingAttachments: false });
    if (!this.draftKey) return;
    // Does not handle race conditions from rapid session switching while reading local drafts.
    try {
      const draft = await readDraft(this.draftKey);
      if (draft) this.#restoreInput(draft, false);
    } finally {
      this.#state({ loadingDraft: false });
    }
  };

  #saveDraft = async () => {
    if (!this.draftKey) return;
    try {
      await saveDraft(this.draftKey, {
        text: this.#state.draft,
        attachments: this.#state.attachments,
        quote: this.#state.quote,
      });
    } catch {
      // Attachments may exhaust storage quota; notify user that the draft was not saved.
      Toast.open('error', i18n.get('composer.draftSaveFailed'));
    }
  };

  get #activeSuggestion() {
    const { draft, quote, attachments } = this.#state;
    return draft || quote || attachments.length ? '' : this.suggestion;
  }

  get #matchedCommands() {
    const query = /^\/(\S*)$/.exec(this.#state.draft)?.[1].toLowerCase();
    if (query === undefined) return [];
    const matched = this.commands.filter(({ name }) => name.toLowerCase().includes(query));
    return [
      ...matched.filter(({ name }) => name.toLowerCase().startsWith(query)),
      ...matched.filter(({ name }) => !name.toLowerCase().startsWith(query)),
    ];
  }

  #selectCommand = (name: string) => {
    hapticSelection();
    this.#replaceInputRange(0, this.#state.draft.length, `/${name} `);
  };

  get #voiceChatEntry() {
    const { draft, quote, attachments } = this.#state;
    return (
      speechSupported &&
      !this.pending &&
      !draft.trim() &&
      !quote.trim() &&
      !attachments.length &&
      !this.#activeSuggestion
    );
  }

  get #canSend() {
    return (
      this.ready &&
      !this.#state.loadingDraft &&
      !this.pending &&
      Boolean(
        this.#state.draft.trim() ||
          this.#state.quote.trim() ||
          this.#state.attachments.length ||
          this.#activeSuggestion,
      ) &&
      this.#state.attachments.length <= MAX_ATTACHMENTS &&
      !this.#state.readingAttachments &&
      !this.#state.submitting
    );
  }

  #send = async () => {
    if (this.#state.attachments.length > MAX_ATTACHMENTS) {
      Toast.open('warning', i18n.get('composer.tooManyAttachments'));
      return;
    }
    if (!this.#canSend || !this.submit) return;
    const draftText = this.#state.draft.trim() || this.#activeSuggestion;
    const quoteText = this.#state.quote.trim();
    const promptText = quoteText ? (draftText ? `"${quoteText}"\n\n${draftText}` : `"${quoteText}"`) : draftText;
    const input: ComposerInput = { text: promptText, attachments: this.#state.attachments };
    this.#clearInput();
    this.#state({ submitting: true });
    hapticSelection();
    try {
      await this.submit(input);
    } finally {
      this.#state({ submitting: false });
    }
  };

  #setDraft = (value: string) => {
    this.draftChange();
    this.#state({
      draft: value,
      attachments: syncPasteReferences(value, this.#state.attachments, this.#pastedAttachments.values()),
    });
    this.#saveDraft();
  };

  #clearInput = () => {
    this.#nextPasteReference = 1;
    this.#pastedAttachments.clear();
    this.#state({ draft: '', quote: '', attachments: [] });
    if (this.#textareaRef.value) this.#textareaRef.value.value = '';
    this.#stopDictation();
  };

  #stopDictation = () => {
    if (!this.#state.dictating) return;
    this.#stopDictationSession?.();
    this.#state({ dictating: false });
  };

  #toggleDictation = async () => {
    if (this.#state.dictating) return this.#stopDictation();
    try {
      if (!(await ensureRecognitionPermission())) {
        Toast.open('warning', i18n.get('speechRecognition.permissionDenied'));
        return;
      }
      hapticSelection();
      this.#stopDictationSession = await startRecognitionSession({
        base: this.#state.draft.trim(),
        onTranscript: this.#setDraft,
        onError: () => {
          Toast.open('error', i18n.get('speechRecognition.failed'));
          this.#state({ dictating: false });
        },
      });
      this.#state({ dictating: true });
    } catch {
      Toast.open('error', i18n.get('speechRecognition.unavailable'));
    }
  };

  @unmounted()
  #stopDictationOnUnmount = () => this.#stopDictation();

  restoreIfEmpty = (key: string, message: ComposerInput) => {
    if (this.draftKey === key && !this.#state.draft && !this.#state.quote && !this.#state.attachments.length)
      this.restore(message);
  };

  #setQuote = (quote: string) => {
    this.draftChange();
    this.#state({ quote });
    this.#saveDraft();
  };

  quoteText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#setQuote(trimmed);
    const textarea = this.#textareaRef.value;
    if (textarea) {
      textarea.focus?.();
      textarea.scrollIntoView?.({ block: 'nearest' });
    }
  };

  restore = (message: { text: string; attachments?: Attachment[]; quote?: string }) => {
    this.#restoreInput(message, true);
    this.#saveDraft();
  };

  #restoreInput = (message: { text: string; attachments?: Attachment[]; quote?: string }, focus: boolean) => {
    this.#pastedAttachments.clear();
    for (const attachment of message.attachments ?? []) {
      if (attachment.marker) this.#pastedAttachments.set(attachment.id, attachment);
    }
    this.#nextPasteReference = Math.max(0, ...(message.attachments ?? []).map((item) => item.pasteReference ?? 0)) + 1;
    this.#state({
      draft: message.text,
      quote: message.quote ?? '',
      attachments: message.attachments ?? [],
    });
    if (this.#textareaRef.value) {
      this.#textareaRef.value.value = message.text;
      if (focus) this.#textareaRef.value.focus();
    }
  };

  #readFiles = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.#addFiles(files);
  };

  #addFiles = async (files: File[], selection?: InputSelection) => {
    if (!files.length || this.#state.loadingDraft) return;
    if (this.#state.readingAttachments) {
      Toast.open('info', i18n.get('composer.readingAttachments'));
      return;
    }
    if (files.length + this.#state.attachments.length > MAX_ATTACHMENTS) {
      Toast.open('warning', i18n.get('composer.maxAttachments'));
      return;
    }
    this.#state({ readingAttachments: true });
    // No extra isolation when switching sessions while reading attachments.
    const results = await Promise.allSettled(files.map(readAttachment));
    const attachments: Attachment[] = [];
    const errors: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') attachments.push(result.value);
      else errors.push(attachmentErrorMessage(result.reason));
    }
    if (selection) this.#insertPastedAttachments(attachments, selection);
    else this.#state({ attachments: [...this.#state.attachments, ...attachments] });
    this.#saveDraft();
    if (errors.length) {
      Toast.open('error', errors.join('\n'));
    }
    this.#state({ readingAttachments: false });
  };

  #removeAttachment = (event: CustomEvent<string>) => {
    const attachment = this.#state.attachments.find((item) => item.id === event.detail);
    const textarea = this.#textareaRef.value;
    if (attachment?.marker && textarea) {
      const input = this.#state.draft;
      const caret = input.slice(0, textarea.selectionStart).replaceAll(attachment.marker, '').length;
      this.#replaceInputRange(0, input.length, input.replaceAll(attachment.marker, ''));
      textarea.setSelectionRange(caret, caret);
      return;
    }
    this.#state({ attachments: this.#state.attachments.filter((item) => item.id !== event.detail) });
    this.#saveDraft();
  };

  #replaceInputRange = (start: number, end: number, replacement: string) => {
    const textarea = this.#textareaRef.value;
    if (!textarea) return;
    const next = this.#state.draft.slice(0, start) + replacement + this.#state.draft.slice(end);
    textarea.focus();
    textarea.setSelectionRange(start, end);
    // Keep native undo/redo for both marker insertion and removal.
    document.execCommand(replacement ? 'insertText' : 'delete', false, replacement);
    if (textarea.value !== next) textarea.value = next;
    this.#setDraft(next);
    textarea.setSelectionRange(start + replacement.length, start + replacement.length);
  };

  #insertPastedAttachments = (attachments: Attachment[], selection: InputSelection) => {
    if (!attachments.length) return;
    const textarea = this.#textareaRef.value;
    if (!textarea) return;
    const { start, end } =
      selection.input === this.#state.draft
        ? selection
        : { start: textarea.selectionStart, end: textarea.selectionEnd };
    const range = expandReferenceRange(this.#state.draft, this.#state.attachments, start, end, true);
    const references = attachments.map((attachment) => createPasteReference(attachment, this.#nextPasteReference++));
    for (const attachment of references) this.#pastedAttachments.set(attachment.id, attachment);
    this.#replaceInputRange(range.start, range.end, references.map((item) => item.marker).join(' '));
  };

  #onBeforeInput = (event: InputEvent) => {
    const textarea = event.target as HTMLTextAreaElement;
    let { selectionStart: start, selectionEnd: end } = textarea;
    const inserting = event.inputType.startsWith('insert');
    if (!inserting) {
      if (!event.inputType.startsWith('delete')) return;
      if (start === end) {
        if (event.inputType === 'deleteWordBackward') {
          start = this.#state.draft.slice(0, start).replace(/[ \t]+$/, '').length;
        } else if (event.inputType === 'deleteWordForward') {
          end += this.#state.draft.slice(end).match(/^[ \t]*/)?.[0].length ?? 0;
        }
        if (event.inputType.endsWith('Backward')) start = Math.max(0, start - 1);
        else if (event.inputType.endsWith('Forward')) end = Math.min(this.#state.draft.length, end + 1);
        else return;
      }
    }
    const range = expandReferenceRange(this.#state.draft, this.#state.attachments, start, end, inserting);
    if (range.start !== start || range.end !== end) textarea.setSelectionRange(range.start, range.end);
  };

  #fillSuggestion = () => {
    const suggestion = this.#activeSuggestion;
    if (!suggestion) return;
    hapticSelection();
    this.#replaceInputRange(0, 0, suggestion);
  };

  // iOS only opens the keyboard during user gestures; focus inside timers does not count, so refocus on release
  #focusAtEnd = () => {
    const textarea = this.#textareaRef.value;
    if (!textarea) return;
    textarea.blur();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  };

  #onPaste = (event: ClipboardEvent) => {
    const textarea = event.target as HTMLTextAreaElement;
    const selection = { input: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (images.length) {
      event.preventDefault();
      this.#addFiles(images, selection);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.length < LONG_PASTE_CHAR_THRESHOLD) return;
    event.preventDefault();
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
      Toast.open('warning', i18n.get('composer.pasteTooLarge'));
      return;
    }
    this.#addFiles([new File([text], 'Pasted text.txt', { type: 'text/plain' })], selection);
  };

  #onKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.#send();
    }
  };

  @template()
  #render = () => {
    const canSend = this.#canSend;
    const commands = this.#matchedCommands;
    return html`
          <div class="composer-shell px-2.5 pt-1.5">
            <div class="composer-surface mx-auto max-w-[760px] overflow-hidden border border-primary/15 bg-bg-light shadow-card">
              <div
                v-if=${commands.length > 0}
                class="max-h-52 overflow-y-auto border-b border-primary/10 py-1.5"
                role="listbox"
                aria-label=${i18n.get('composer.commandsAria')}
              >
                ${commands.map(
                  ({ name, description }) => html`
                    <button
                      type="button"
                      role="option"
                      class="block w-full cursor-pointer border-0 bg-transparent px-3.5 py-2 text-left active:bg-bg-hover"
                      @pointerdown=${(event: PointerEvent) => event.preventDefault()}
                      @click=${() => this.#selectCommand(name)}
                    >
                      <div class="truncate text-sm font-medium text-highlight">/${name}</div>
                      <div v-if=${!!description} class="truncate text-xs text-describe">${description}</div>
                    </button>
                  `,
                )}
              </div>
              <div v-if=${this.#state.attachments.length} class="flex max-h-40 flex-wrap gap-3 overflow-y-auto px-3.5 pt-3.5 pb-1.5">
                ${this.#state.attachments.map(
                  (attachment) => html`
                    <deck-attachment
                      compact
                      ?removable=${!this.#state.submitting}
                      .attachment=${attachment}
                      @preview=${(event: CustomEvent<Attachment>) => this.preview(event.detail)}
                      @request-remove=${this.#removeAttachment}
                    ></deck-attachment>
                  `,
                )}
              </div>

              <div v-if=${this.#state.quote} class="mx-3.5 mt-3 flex items-start gap-2 rounded-xl bg-bg/60 px-3 py-2 text-xs">
                <div class="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap italic text-describe">${this.#state.quote}</div>
                <button
                  type="button"
                  class="grid size-5 shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent text-describe transition-colors hover:text-text"
                  aria-label=${i18n.get('composer.removeQuoteAria')}
                  @click=${() => this.#setQuote('')}
                >
                  <tap-use class="size-3.5" .element=${icons.close}></tap-use>
                </button>
              </div>
              <textarea
                ${this.#textareaRef}
                ${longPress(this.#fillSuggestion, { disabled: !this.#activeSuggestion, release: this.#focusAtEnd })}
                class="block min-h-[50px] max-h-[140px] w-full resize-none border-0 bg-transparent px-3.5 pt-[13px] pb-1.5 text-base leading-[1.5] text-highlight outline-none [field-sizing:content] placeholder:text-disabled focus:outline-none ${this.#activeSuggestion ? '[-webkit-touch-callout:none]' : ''}"
                rows="1"
                aria-label=${i18n.get('composer.sendMessageAria')}
                placeholder=${this.#activeSuggestion || this.placeholder}
                .value=${this.#state.draft}
                @input=${(event: InputEvent) => this.#setDraft((event.target as HTMLTextAreaElement).value)}
                @beforeinput=${this.#onBeforeInput}
                @paste=${this.#onPaste}
                @keydown=${this.#onKeydown}
                ?disabled=${this.disabled || this.#state.submitting || this.#state.loadingDraft}
              ></textarea>
              <div class="flex min-h-11 items-center justify-between gap-2.5 px-2 pt-1 pb-2">
                <div class="flex min-w-0 items-center gap-2 text-sm font-medium text-describe">
                  <input ${this.#fileInputRef} type="file" multiple hidden aria-label=${i18n.get('composer.inputFileAria')} @change=${this.#readFiles} />
                  <button
                    type="button"
                    class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-describe active:bg-bg-hover disabled:cursor-default disabled:opacity-45"
                    aria-label=${i18n.get('composer.addAttachmentAria')}
                    title=${i18n.get('composer.addAttachmentTitle')}
                    ?disabled=${this.#state.loadingDraft || this.#state.readingAttachments || this.#state.submitting || this.#state.attachments.length >= MAX_ATTACHMENTS}
                    @click=${() => this.#fileInputRef.value?.click()}
                  >
                    <tap-use class="size-5" .element=${this.#state.readingAttachments ? icons.loading : icons.paperclip}></tap-use>
                  </button>
                  <span v-if=${this.#state.readingAttachments || this.#state.submitting} class="truncate">
                    ${this.#state.readingAttachments ? i18n.get('composer.readingState') : i18n.get('composer.preparingSession')}
                  </span>
                  <button
                    v-if=${!!this.configLabel}
                    type="button"
                    class="flex min-h-9 min-w-0 cursor-pointer items-center gap-1 rounded-lg border-0 bg-transparent px-1 text-sm font-medium text-describe disabled:cursor-default disabled:opacity-50"
                    aria-label=${i18n.get('composer.configAria')}
                    ?disabled=${!this.ready || this.#state.submitting}
                    @click=${() => this.configOpen()}
                  >
                    <span class="truncate">${this.configLabel}</span>
                    <tap-use class="size-3.5 shrink-0" .element=${icons.expand}></tap-use>
                  </button>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <button
                    v-if=${speechSupported}
                    type="button"
                    class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent active:bg-bg-hover disabled:cursor-default disabled:opacity-45 ${this.#state.dictating ? 'text-primary' : 'text-describe'}"
                    aria-label=${this.#state.dictating ? i18n.get('composer.stopDictationAria') : i18n.get('composer.startDictationAria')}
                    title=${this.#state.dictating ? i18n.get('composer.stopDictationAria') : i18n.get('composer.startDictationAria')}
                    ?disabled=${this.#state.loadingDraft || this.#state.readingAttachments || this.#state.submitting}
                    @click=${this.#toggleDictation}
                  >
                    <tap-use class="size-5" .element=${this.#state.dictating ? icons.stop : icons.mic}></tap-use>
                  </button>
                  <button
                    v-if=${this.pending}
                    class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-primary text-white transition-transform duration-150 active:scale-[0.92]"
                    aria-label=${i18n.get('composer.stopAria')}
                    @click=${() => this.cancel()}
                  >
                    <span class="size-2.5 rounded-[3px] bg-current"></span>
                  </button>
                  <button
                    v-else-if=${this.#voiceChatEntry}
                    class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-primary text-white transition-[transform,background-color] duration-150 active:scale-[0.92] disabled:cursor-default disabled:bg-border disabled:text-disabled disabled:active:scale-100"
                    ?disabled=${!this.ready || this.#state.loadingDraft || this.#state.submitting}
                    aria-label=${i18n.get('composer.voiceChatAria')}
                    @click=${() => {
                      this.#stopDictation();
                      this.voiceChat();
                    }}
                  >
                    <tap-use class="size-[18px]" .element=${icons.audioLines}></tap-use>
                  </button>
                  <button
                    v-else
                    class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-primary text-white transition-[transform,background-color] duration-150 active:scale-[0.92] disabled:cursor-default disabled:bg-border disabled:text-disabled disabled:active:scale-100"
                    ?disabled=${!canSend}
                    aria-label=${i18n.get('composer.sendAria')}
                    @click=${this.#send}
                  >
                    <tap-use class="size-[17px]" .element=${icons.arrowUp}></tap-use>
                  </button>
                </div>
              </div>
            </div>
          </div>
    `;
  };
}
