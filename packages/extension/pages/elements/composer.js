import { AttachmentError, MAX_ATTACHMENTS, MAX_TEXT_BYTES, readAttachment } from 'agentdeck/attachment/read';
import {
  createPasteReference,
  expandReferenceRange,
  LONG_PASTE_CHAR_THRESHOLD,
  syncPasteReferences,
} from 'agentdeck/composer/references';
import { icons } from 'agentdeck/styles/icons';
import { t } from '../../shared/i18n.js';

// ACP categories merged into one picker; trigger shows model + effort, e.g. Codex and Claude Agent
const MODEL_CONFIG_CATEGORIES = ['model', 'thought_level', 'model_config'];

const queueButtonClass =
  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-describe transition-[background-color,color] duration-150 hover:bg-bg-light hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const sendButtonClass =
  'ml-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-primary text-white transition-[opacity,transform] duration-150 hover:opacity-[.85] active:scale-[.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:bg-disabled disabled:text-describe disabled:hover:opacity-100';

const stopButtonClass =
  'ml-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border border-border bg-transparent text-describe transition-[background-color,color] duration-150 hover:bg-bg-light hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

@customElement('agent-composer')
class AgentComposerElement extends GemElement {
  @boolattribute turnPending;
  @property configOptions;
  @property sessionKey;
  @property queue; // staged prompts while one is in flight

  @emitter send;
  @emitter cancel;
  @emitter configchange;
  @emitter attacherror;
  @emitter queuesend; // detail: queued item id
  @emitter queueupdate; // detail: { id, prompt, attachments }
  @emitter queueremove; // detail: queued item id

  #s = createState({
    input: '',
    attachments: [], // staged prompt attachments: { id, kind: 'image'|'text'|'file', name, … }
    editingId: null, // Queued item currently being edited: sending will update it in place instead of posting a new one
  });

  #fileInputRef = createRef();
  #textareaRef = createRef();
  #nextPasteReference = 1;
  #pastedAttachments = new Map();

  focus = () => {
    this.#textareaRef.value?.focus();
  };

  /** The DOM value is reset imperatively too: template property bindings only
   * rewrite when the bound value differs from their last commit, which can
   * desync once the user edited the field directly. */
  #setInput = (value) => {
    this.#s({ input: value });
    if (this.#textareaRef.value) this.#textareaRef.value.value = value;
  };

  #clearDraft = () => {
    this.#nextPasteReference = 1;
    this.#pastedAttachments.clear();
    this.#s({ attachments: [], editingId: null });
    this.#setInput('');
  };

  @effect((i) => [i.sessionKey])
  #resetOnSessionChange = () => {
    this.#clearDraft();
  };

  get #canSend() {
    return Boolean(this.#s.input.trim()) || this.#s.attachments.length > 0;
  }

  /** Clear up front: while a turn is in flight the parent stages the prompt
   * into its queue instead of delivering it; while editing a queue entry the
   * parent patches that entry in place. */
  #emitSend = () => {
    if (!this.#canSend) return;
    const prompt = this.#s.input.trim();
    const attachments = this.#s.attachments;
    const editingId = this.#s.editingId;
    this.#clearDraft();
    if (editingId) this.queueupdate({ id: editingId, prompt, attachments });
    else this.send({ prompt, attachments });
  };

  #onKeydown = (e) => {
    // Enter during IME composition confirms character selection and must not trigger send
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.#emitSend();
    }
  };

  #openFilePicker = () => {
    this.#fileInputRef.value?.click();
  };

  #onFileInputChange = (e) => {
    this.#addFiles(e.target.files);
    e.target.value = '';
  };

  #readFile = async (file) => {
    try {
      return { attachment: await readAttachment(file) };
    } catch (error) {
      const tooLarge = error instanceof AttachmentError && error.reason === 'tooLarge';
      return { reason: t(tooLarge ? 'devtoolsPanelAttachmentTooLarge' : 'devtoolsPanelAttachmentFailed') };
    }
  };

  #readFiles = async (fileList) => {
    // dy-drop-area wraps plain-text drags as { name: 'temp', type: '*' } —
    // ignore them; pasting covers that case.
    const room = MAX_ATTACHMENTS - this.#s.attachments.length;
    const files = [...fileList].filter((file) => file.type !== '*').slice(0, Math.max(room, 0));
    if (!files.length) return [];
    const results = await Promise.all(files.map((file) => this.#readFile(file)));
    const added = results.flatMap(({ attachment }) => (attachment ? [attachment] : []));
    const reason = results.find(({ reason }) => reason)?.reason || '';
    if (reason) this.attacherror(reason);
    return added;
  };

  #addFiles = async (fileList) => {
    const added = await this.#readFiles(fileList);
    if (added.length) this.#s({ attachments: [...this.#s.attachments, ...added] });
  };

  #syncInput = (input) => {
    this.#s({ input, attachments: syncPasteReferences(input, this.#s.attachments, this.#pastedAttachments.values()) });
  };

  #replaceInputRange = (start, end, replacement, addedAttachments = []) => {
    const input = this.#s.input;
    start = Math.max(0, Math.min(start, input.length));
    end = Math.max(start, Math.min(end, input.length));
    const nextInput = `${input.slice(0, start)}${replacement}${input.slice(end)}`;
    for (const attachment of addedAttachments) this.#pastedAttachments.set(attachment.id, attachment);
    const textarea = this.#textareaRef.value;
    if (!textarea) {
      this.#syncInput(nextInput);
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(start, end);
    try {
      document.execCommand(replacement ? 'insertText' : 'delete', false, replacement);
    } catch {
      // Fall through to the direct-value fallback below.
    }
    if (textarea.value !== nextInput) textarea.value = nextInput;
    if (this.#s.input !== nextInput) this.#syncInput(nextInput);
    const caret = start + replacement.length;
    textarea.setSelectionRange(caret, caret);
  };

  #insertPastedAttachments = (attachments, selection) => {
    if (!attachments.length) return;
    const textarea = this.#textareaRef.value;
    const currentSelection =
      selection.input === this.#s.input
        ? selection
        : {
            start: textarea?.selectionStart ?? this.#s.input.length,
            end: textarea?.selectionEnd ?? this.#s.input.length,
          };
    const range = expandReferenceRange(
      this.#s.input,
      this.#s.attachments,
      currentSelection.start,
      currentSelection.end,
      true,
    );
    const references = attachments.map((attachment) => createPasteReference(attachment, this.#nextPasteReference++));
    this.#replaceInputRange(range.start, range.end, references.map((item) => item.marker).join(' '), references);
  };

  #removeAttachment = (id) => {
    const attachment = this.#s.attachments.find((item) => item.id === id);
    const markerStart = attachment?.marker ? this.#s.input.indexOf(attachment.marker) : -1;
    if (markerStart >= 0) {
      this.#replaceInputRange(markerStart, markerStart + attachment.marker.length, '');
      return;
    }
    this.#s({ attachments: this.#s.attachments.filter((item) => item.id !== id) });
  };

  #onBeforeInput = (e) => {
    const textarea = e.target;
    let start = textarea.selectionStart ?? 0;
    let end = textarea.selectionEnd ?? start;
    if (e.inputType.startsWith('insert')) {
      const range = expandReferenceRange(this.#s.input, this.#s.attachments, start, end, true);
      if (range.start !== start || range.end !== end) textarea.setSelectionRange(range.start, range.end);
      return;
    }
    if (!e.inputType.startsWith('delete')) return;
    if (start === end) {
      if (e.inputType.endsWith('Backward')) start = Math.max(0, start - 1);
      else if (e.inputType.endsWith('Forward')) end = Math.min(this.#s.input.length, end + 1);
      else return;
    }
    const range = expandReferenceRange(this.#s.input, this.#s.attachments, start, end);
    if (range.start === start && range.end === end) return;
    textarea.setSelectionRange(range.start, range.end);
  };

  #onInput = (e) => {
    this.#syncInput(e.target.value);
  };

  #onPaste = async (e) => {
    const selection = {
      input: this.#s.input,
      start: e.target.selectionStart ?? this.#s.input.length,
      end: e.target.selectionEnd ?? this.#s.input.length,
    };
    const images = [...(e.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (images.length) {
      e.preventDefault();
      const added = await this.#readFiles(images);
      this.#insertPastedAttachments(added, selection);
      return;
    }

    const text = e.clipboardData?.getData('text/plain') || '';
    if (text.length < LONG_PASTE_CHAR_THRESHOLD || this.#s.attachments.length >= MAX_ATTACHMENTS) return;

    e.preventDefault();
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
      this.attacherror(t('devtoolsPanelPasteTooLarge'));
      return;
    }
    this.#insertPastedAttachments([{ id: crypto.randomUUID(), kind: 'text', name: '', text }], selection);
  };

  /** Put a queued prompt back into the draft; sending then updates that
   * entry in place. Clicking its row button again cancels editing. */
  #editQueued = (id) => {
    if (this.#s.editingId === id) {
      this.#s({ editingId: null });
      return;
    }
    const item = (this.queue || []).find((entry) => entry.id === id);
    if (!item) return;
    this.#s({ editingId: id });
    this.#setInput(item.prompt);
    const attachments = item.attachments || [];
    this.#s({ attachments });
    this.#pastedAttachments.clear();
    for (const attachment of attachments) {
      if (attachment.marker) this.#pastedAttachments.set(attachment.id, attachment);
    }
    this.#nextPasteReference = Math.max(0, ...attachments.map((attachment) => attachment.pasteReference || 0)) + 1;
    this.focus();
  };

  #renderModelConfigValue = (value) =>
    ['model', 'thought_level']
      .map((category) => this.configOptions?.find((option) => option.category === category))
      .map((option) => option?.options.find((item) => item.value === value?.[option.id])?.name)
      .filter(Boolean)
      .join(' ');

  @template()
  #content = () => {
    const { input, attachments, editingId } = this.#s;
    const pending = this.turnPending;
    const configOptions = this.configOptions || [];
    const modelConfigOptions = configOptions.filter((option) => MODEL_CONFIG_CATEGORIES.includes(option.category));
    const standaloneConfigOptions = configOptions.filter((option) => !modelConfigOptions.includes(option));
    const modelPickerOptions = modelConfigOptions.map((option) => ({
      label: option.name,
      description: option.description,
      value: option.id,
      children: option.options.map((item) => ({
        label: item.name,
        description: item.description,
        value: item.value,
      })),
    }));
    const modelPickerValue = Object.fromEntries(modelConfigOptions.map((option) => [option.id, option.currentValue]));
    const modelConfigSummary = modelConfigOptions
      .map(
        (option) =>
          `${option.name}: ${option.options.find((item) => item.value === option.currentValue)?.name || option.currentValue}`,
      )
      .join('; ');
    const canSend = this.#canSend;
    // Dual state for primary button when busy: "Enqueue" with draft, "Stop" with empty draft
    const mainIcon = pending ? (canSend ? icons.queueAdd : icons.stop) : icons.arrowUp;
    const mainTitle = pending
      ? canSend
        ? t('devtoolsPanelEnqueue')
        : t('devtoolsPanelCancel')
      : t('devtoolsPanelSend');
    return html`
      <div v-if=${!!this.queue?.length} class="mb-2">
        <div class="px-1 pb-1 text-xs text-describe">${t('devtoolsPanelQueuedPrompts')}</div>
        <div class="flex flex-col gap-1.5">
          ${this.queue?.map(
            (item) => html`
              <div
                class=${`group flex items-center gap-2 rounded-lg border bg-bg px-3 py-1.5 ${
                  item.id === this.#s.editingId ? 'border-focus' : 'border-border'
                }`}
              >
                <div class="min-w-0 flex-1 self-stretch flex flex-col justify-center">
                  <div class="truncate text-sm text-text" title=${item.prompt}>${item.prompt}</div>
                  <div v-if=${item.attachments.length} class="truncate text-xs text-describe">
                    ${item.attachments.map((attachment) => attachment.name).join(' · ')}
                  </div>
                </div>
                <div
                  class="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <button
                    type="button"
                    class=${queueButtonClass}
                    title=${t('devtoolsPanelSendNow')}
                    aria-label=${t('devtoolsPanelSendNow')}
                    @click=${() => {
                      if (this.#s.editingId === item.id) this.#s({ editingId: null });
                      this.queuesend(item.id);
                    }}
                  >
                    <dy-use class="size-4" .element=${icons.send}></dy-use>
                  </button>
                  <button
                    type="button"
                    class=${queueButtonClass}
                    title=${t('devtoolsPanelEditPrompt')}
                    aria-label=${t('devtoolsPanelEditPrompt')}
                    @click=${() => this.#editQueued(item.id)}
                  >
                    <dy-use class="size-4" .element=${icons.edit}></dy-use>
                  </button>
                  <button
                    type="button"
                    class=${queueButtonClass}
                    title=${t('devtoolsPanelRemovePrompt')}
                    aria-label=${t('devtoolsPanelRemovePrompt')}
                    @click=${() => {
                      if (this.#s.editingId === item.id) this.#s({ editingId: null });
                      this.queueremove(item.id);
                    }}
                  >
                    <dy-use class="size-4" .element=${icons.delete}></dy-use>
                  </button>
                </div>
              </div>
            `,
          )}
        </div>
      </div>
      <dy-drop-area
        class="block w-full"
        tip=${t('devtoolsPanelDropToAttach')}
        @change=${
          // The emitter is global: native `change` events (e.g. input blur)
          // bubble here too and carry no detail — only react to file lists.
          (e) => {
            if (Array.isArray(e.detail)) this.#addFiles(e.detail);
          }
        }
      >
        <div
          class="w-full rounded-lg border border-border bg-bg transition-[border-color,box-shadow] duration-150 focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/15"
        >
          <div v-if=${attachments.length} class="flex flex-wrap gap-1.5 px-3 pt-2">
            ${attachments.map(
              (item) => html`
                <agent-attachment
                  .attachment=${item}
                  removable
                  @request-remove=${(e) => this.#removeAttachment(e.detail)}
                ></agent-attachment>
              `,
            )}
          </div>
          <textarea
            ${this.#textareaRef}
            class="field-sizing-content box-border block min-h-13 max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent px-3.5 pb-1 pt-3 text-sm leading-6 text-text outline-none placeholder:text-describe"
            rows="1"
            placeholder=${editingId ? t('devtoolsPanelEditHint') : t('devtoolsPanelPlaceholder')}
            @beforeinput=${this.#onBeforeInput}
            @input=${this.#onInput}
            @keydown=${this.#onKeydown}
            @paste=${this.#onPaste}
          ></textarea>
          <div class="flex min-h-10 items-center gap-1 px-2 pb-2">
            <button
              type="button"
              class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-describe transition-[background-color,color] duration-150 hover:bg-bg-light hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              ?disabled=${attachments.length >= MAX_ATTACHMENTS}
              title=${t('devtoolsPanelAttach')}
              aria-label=${t('devtoolsPanelAttach')}
              @click=${this.#openFilePicker}
            >
              <dy-use class="size-4" .element=${icons.add}></dy-use>
            </button>
            <div class="ml-auto flex min-w-0 items-center">
              <div
                v-if=${standaloneConfigOptions.length || modelConfigOptions.length}
                class="flex min-w-0 flex-wrap items-center gap-1"
              >
                ${standaloneConfigOptions.map(
                  (option) => html`
                    <dy-picker
                      borderless
                      class="max-w-40"
                      placeholder=${option.name}
                      .options=${option.options.map((item) => ({
                        label: item.name,
                        description: item.description,
                        value: item.value,
                      }))}
                      .value=${option.currentValue}
                      aria-label=${option.name}
                      title=${option.description || option.name}
                      @change=${(e) => this.configchange({ configId: option.id, value: e.detail })}
                    ></dy-picker>
                  `,
                )}
                <agent-grouped-picker
                  v-if=${modelConfigOptions.length}
                  borderless
                  class="max-w-40"
                  placeholder=${modelConfigOptions[0]?.name}
                  .options=${modelPickerOptions}
                  .value=${modelPickerValue}
                  .renderValue=${this.#renderModelConfigValue}
                  aria-label=${modelConfigSummary}
                  title=${modelConfigSummary}
                  @change=${(event) => this.configchange({ configId: event.detail.group, value: event.detail.value })}
                ></agent-grouped-picker>
              </div>
              <button
                type="button"
                class=${pending && !canSend ? stopButtonClass : sendButtonClass}
                ?disabled=${!pending && !canSend}
                title=${mainTitle}
                aria-label=${mainTitle}
                @click=${() => (pending && !canSend ? this.cancel() : this.#emitSend())}
              >
                <dy-use class="size-4" .element=${mainIcon}></dy-use>
              </button>
            </div>
          </div>
        </div>
      </dy-drop-area>
      <input ${this.#fileInputRef} class="hidden" type="file" multiple @change=${this.#onFileInputChange} />
    `;
  };
}
