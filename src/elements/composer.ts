import type { Emitter } from '@mantou/gem/lib/decorators';
import { icons } from '@mantou/tap-ui/lib/icons';
import { MAX_ATTACHMENTS, MAX_TEXT_BYTES, readAttachment } from '../composer/files';
import {
  createPasteReference,
  expandReferenceRange,
  LONG_PASTE_CHAR_THRESHOLD,
  syncPasteReferences,
} from '../composer/references';
import type { ModeSelection } from '../session/modes';
import type { Attachment, TextMessage } from '../session/types';

export type ComposerInput = { text: string; attachments: Attachment[] };
type InputSelection = { input: string; start: number; end: number };
const style = css`
  :scope { display: block; }
  .composer-shell { padding-bottom: calc(9px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))); }
`;

@customElement('deck-composer')
@adoptedStyle(style)
export class DeckComposerElement extends GemElement {
  @property sessionKey = '';
  @property mode?: ModeSelection;
  @boolattribute modeBusy: boolean;
  @emitter modeChange: Emitter<string>;
  @property placeholder = '';
  @property submit?: (input: ComposerInput) => boolean | Promise<boolean>;
  @boolattribute disabled: boolean;
  @boolattribute ready: boolean;
  @boolattribute pending: boolean;
  @emitter cancel: Emitter;
  @emitter preview: Emitter<Attachment>;
  @emitter draftChange: Emitter;
  @emitter restoreChange: Emitter<boolean>;

  #state = createState({
    draft: '',
    attachments: [] as Attachment[],
    attachmentError: '',
    readingAttachments: false,
    submitting: false,
  });
  #textareaRef = createRef<HTMLTextAreaElement>();
  #fileInputRef = createRef<HTMLInputElement>();
  #nextPasteReference = 1;
  #pastedAttachments = new Map<string, Attachment>();

  @effect((i) => [i.sessionKey])
  #resetInput = () => this.#clearInput();

  @effect((i) => [i.#canRestoreInput])
  #reportRestore = () => this.restoreChange(this.#canRestoreInput);

  get #canSend() {
    return (
      this.ready &&
      Boolean(this.#state.draft.trim() || this.#state.attachments.length) &&
      this.#state.attachments.length <= MAX_ATTACHMENTS &&
      !this.#state.readingAttachments &&
      !this.#state.submitting
    );
  }

  #send = async () => {
    if (!this.#canSend || !this.submit) return;
    this.#state({ submitting: true });
    try {
      if (await this.submit({ text: this.#state.draft.trim(), attachments: this.#state.attachments }))
        this.#clearInput();
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
  };

  #clearInput = () => {
    this.#nextPasteReference = 1;
    this.#pastedAttachments.clear();
    this.#state({ draft: '', attachments: [], attachmentError: '' });
    if (this.#textareaRef.value) this.#textareaRef.value.value = '';
  };

  get #canRestoreInput() {
    return (
      !this.#state.draft.trim() &&
      !this.#state.attachments.length &&
      !this.#state.readingAttachments &&
      !this.#state.submitting
    );
  }

  restore = (message: TextMessage) => {
    if (!this.#canRestoreInput) return;
    this.#pastedAttachments.clear();
    for (const attachment of message.attachments ?? []) {
      if (attachment.marker) this.#pastedAttachments.set(attachment.id, attachment);
    }
    this.#nextPasteReference = Math.max(0, ...(message.attachments ?? []).map((item) => item.pasteReference ?? 0)) + 1;
    this.#setDraft(message.text);
    this.#state({ attachments: message.attachments ?? [], attachmentError: '' });
    if (this.#textareaRef.value) {
      this.#textareaRef.value.value = message.text;
      this.#textareaRef.value.focus();
    }
  };

  #readFiles = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    void this.#addFiles(files);
  };

  #addFiles = async (files: File[], selection?: InputSelection) => {
    if (!files.length) return;
    if (this.#state.readingAttachments) {
      this.#state({ attachmentError: '正在读取附件，请稍后再粘贴或选择文件。' });
      return;
    }
    if (files.length + this.#state.attachments.length > MAX_ATTACHMENTS) {
      this.#state({ attachmentError: '最多添加 10 个附件，请减少选择的文件数量。' });
      return;
    }
    this.#state({ readingAttachments: true, attachmentError: '' });
    const results = await Promise.allSettled(files.map(readAttachment));
    const attachments: Attachment[] = [];
    const errors: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') attachments.push(result.value);
      else errors.push(result.reason.message);
    }
    if (selection) this.#insertPastedAttachments(attachments, selection);
    else this.#state({ attachments: [...this.#state.attachments, ...attachments] });
    this.#state({
      attachmentError: errors.length ? errors.join('\n') : this.#state.attachmentError,
      readingAttachments: false,
    });
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

  #onPaste = (event: ClipboardEvent) => {
    const textarea = event.target as HTMLTextAreaElement;
    const selection = { input: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (images.length) {
      event.preventDefault();
      void this.#addFiles(images, selection);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.length < LONG_PASTE_CHAR_THRESHOLD) return;
    event.preventDefault();
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
      this.#state({ attachmentError: '粘贴的文本超过 256 KB，请缩小内容后重试。' });
      return;
    }
    void this.#addFiles([new File([text], 'Pasted text.txt', { type: 'text/plain' })], selection);
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
    const attachmentError =
      this.#state.attachments.length > MAX_ATTACHMENTS
        ? '附件超过 10 个，请删除多余附件后发送。'
        : this.#state.attachmentError;
    return html`
          <div class="composer-shell bg-bg/90 px-2.5 pt-2 backdrop-blur-xl backdrop-saturate-125">
            <div class="mx-auto max-w-[760px] overflow-hidden rounded-[20px] border border-primary/15 bg-bg-light shadow-card">
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
              <div v-if=${attachmentError} role="alert" class="flex items-start gap-2 px-3.5 pt-3 text-xs text-negative">
                <span class="min-w-0 flex-1 whitespace-pre-line">${attachmentError}</span>
                <button
                  type="button"
                  class="grid size-6 shrink-0 cursor-pointer place-items-center border-0 bg-transparent text-negative"
                  aria-label="关闭附件提示"
                  v-if=${this.#state.attachments.length <= MAX_ATTACHMENTS}
                  @click=${() => this.#state({ attachmentError: '' })}
                >
                  <tap-use class="size-4" .element=${icons.close}></tap-use>
                </button>
              </div>
              <textarea
                ${this.#textareaRef}
                class="block min-h-[50px] max-h-[140px] w-full resize-none border-0 bg-transparent px-3.5 pt-[13px] pb-1.5 text-base leading-[1.5] text-highlight outline-none [field-sizing:content] placeholder:text-disabled focus:outline-none"
                rows="1"
                aria-label="发送消息"
                placeholder=${this.placeholder}
                .value=${this.#state.draft}
                @input=${(event: InputEvent) => this.#setDraft((event.target as HTMLTextAreaElement).value)}
                @beforeinput=${this.#onBeforeInput}
                @paste=${this.#onPaste}
                @keydown=${this.#onKeydown}
                ?disabled=${this.disabled || this.#state.submitting}
              ></textarea>
              <div class="flex min-h-[43px] items-center justify-between gap-2.5 pt-1 pr-1.5 pb-1.5 pl-3">
                <div class="flex min-w-0 items-center gap-2 text-xs font-semibold text-describe">
                  <input ${this.#fileInputRef} type="file" multiple hidden aria-label="附件文件" @change=${this.#readFiles} />
                  <button
                    type="button"
                    class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-xl border-0 bg-transparent text-describe active:bg-bg-hover disabled:cursor-default disabled:opacity-45"
                    aria-label="添加附件"
                    title="添加图片或文本文件，最多 10 个附件"
                    ?disabled=${this.#state.readingAttachments || this.#state.submitting || this.#state.attachments.length >= MAX_ATTACHMENTS}
                    @click=${() => this.#fileInputRef.value?.click()}
                  >
                    <tap-use class="size-5" .element=${this.#state.readingAttachments ? icons.loading : icons.add}></tap-use>
                  </button>
                  <span v-if=${this.#state.readingAttachments || this.#state.submitting} class="truncate">
                    ${this.#state.readingAttachments ? '正在读取附件…' : '正在准备会话…'}
                  </span>
                  <div v-if=${this.mode} class="relative flex min-w-0 items-center gap-1">
                    <select
                      class="min-h-9 max-w-32 min-w-0 cursor-pointer truncate rounded-lg border-0 bg-transparent pr-4 pl-1 text-xs font-semibold text-describe outline-none focus:outline-none disabled:cursor-default disabled:opacity-50"
                      aria-label="会话模式"
                      title=${this.pending ? '任务结束后可切换模式' : this.mode?.choices.find((choice) => choice.value === this.mode?.currentValue)?.description || '会话模式'}
                      ?disabled=${!this.ready || this.#state.submitting}
                      @change=${(event: Event) => {
                        const select = event.target as HTMLSelectElement;
                        const value = select.value;
                        select.value = this.mode?.currentValue ?? '';
                        this.modeChange(value);
                      }}
                    >
                      <option v-if=${this.sessionKey === 'draft'} value="" .selected=${!this.mode?.currentValue}>默认模式</option>
                      ${this.mode?.choices.map((choice) => html`<option value=${choice.value} .selected=${choice.value === this.mode?.currentValue}>${choice.name}</option>`)}
                    </select>
                    <tap-use v-if=${this.modeBusy} class="size-3.5 shrink-0" .element=${icons.loading}></tap-use>
                  </div>
                </div>
                <button
                  v-if=${this.pending}
                  class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-[13px] border-0 bg-primary text-white transition-transform duration-150 active:scale-[0.92]"
                  aria-label="停止生成"
                  @click=${() => this.cancel()}
                >
                  <span class="size-2.5 rounded-[3px] bg-current"></span>
                </button>
                <button
                  v-else
                  class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-[13px] border-0 bg-primary text-white transition-[transform,background-color] duration-150 active:scale-[0.92] disabled:cursor-default disabled:bg-border disabled:text-disabled disabled:active:scale-100"
                  ?disabled=${!canSend}
                  aria-label="发送"
                  @click=${this.#send}
                >
                  <tap-use class="size-[17px]" .element=${icons.outward}></tap-use>
                </button>
              </div>
            </div>
          </div>
    `;
  };
}
