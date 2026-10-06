import type { Emitter } from '@mantou/gem/lib/decorators';
import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { ElicitationResponse, ElicitationValue } from '../agent/api';
import { i18n } from '../i18n';
import { hapticSelection } from '../lib/haptics';
import {
  type Elicitation,
  type ElicitationChoice,
  type ElicitationDraft,
  type ElicitationInput,
  type ElicitationQuestion,
  type ElicitationSelect,
  getElicitationContent,
  getElicitationQuestions,
} from '../session/elicitation';
import { icons } from '../styles/icons';

const button =
  'min-h-11 min-w-0 flex-1 cursor-pointer truncate rounded-xl border px-3 py-2 text-sm font-medium active:scale-[0.98] disabled:cursor-default disabled:opacity-45 disabled:active:scale-100';

const isSelected = (value: ElicitationValue | undefined, choice: ElicitationChoice) =>
  Array.isArray(value) ? value.includes(choice.value as string) : value === choice.value;

/** Form elicitation (e.g. Claude's `AskUserQuestion`) in the timeline; once it has a response only the questions and answers remain. */
@customElement('deck-elicitation')
@adoptedStyle(blockContainer)
export class DeckElicitationElement extends GemElement {
  @property elicitation?: Elicitation;
  @emitter respond: Emitter<ElicitationResponse>;

  #state = createState({ draft: {} as ElicitationDraft });

  @memo((i) => [i.elicitation?.request])
  get #questions() {
    return this.elicitation ? getElicitationQuestions(this.elicitation.request) : [];
  }

  #setValue = (key: string, value: ElicitationValue | undefined) =>
    this.#state({ draft: { ...this.#state.draft, [key]: value } });

  #choose = (select: ElicitationSelect, choice: ElicitationChoice) => {
    hapticSelection();
    const current = this.#state.draft[select.key];
    if (select.kind === 'multi') {
      const values = Array.isArray(current) ? current : [];
      const value = choice.value as string;
      this.#setValue(select.key, values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
    } else {
      this.#setValue(select.key, current === choice.value ? undefined : choice.value);
    }
  };

  #renderChoice = (select: ElicitationSelect, choice: ElicitationChoice) => {
    const selected = isSelected(this.#state.draft[select.key], choice);
    return html`
      <button
        type="button"
        class=${classMap({
          'flex min-h-11 w-full cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 text-left text-sm active:scale-[0.99]': true,
          'border-primary bg-primary-soft text-highlight': selected,
          'border-border bg-bg text-text': !selected,
        })}
        aria-pressed=${String(selected)}
        @click=${() => this.#choose(select, choice)}
      >
        <span
          class=${classMap({
            'mt-0.5 grid size-4 shrink-0 place-items-center text-primary': true,
            'rounded border border-border-strong': select.kind === 'multi' && !selected,
            'rounded bg-primary text-white': select.kind === 'multi' && selected,
          })}
        >
          <tap-use v-if=${selected} class="size-3.5" .element=${icons.check}></tap-use>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block font-medium break-words">${choice.title}</span>
          <span v-if=${!!choice.description} class="mt-0.5 block text-[13px] leading-snug text-describe break-words"
            >${choice.description}</span
          >
        </span>
      </button>
    `;
  };

  #renderInput = (input: ElicitationInput, other: boolean) => {
    const value = this.#state.draft[input.key];
    return html`
      <input
        type=${input.kind === 'text' ? 'text' : 'number'}
        step=${input.kind === 'integer' ? '1' : 'any'}
        class="box-border h-11 w-full rounded-xl border border-border-strong bg-bg px-3 text-base text-text outline-none placeholder:text-disabled focus:border-primary"
        placeholder=${other ? i18n.get('elicitation.otherPlaceholder') : ''}
        aria-label=${input.title || i18n.get('elicitation.other')}
        .value=${value === undefined ? '' : String(value)}
        @input=${(event: InputEvent) => this.#setValue(input.key, (event.target as HTMLInputElement).value)}
      />
    `;
  };

  #renderQuestion = (question: ElicitationQuestion) => {
    const { select, input } = question;
    const { title, description } = select ?? input ?? {};
    return html`
      <div class="flex flex-col gap-2">
        <span v-if=${!!title} class="text-xs font-semibold text-primary-strong">${title}</span>
        <p v-if=${!!description} class="m-0 text-sm leading-relaxed text-highlight">${description}</p>
        ${select?.choices.map((choice) => this.#renderChoice(select, choice))}
        ${input ? this.#renderInput(input, !!select) : ''}
      </div>
    `;
  };

  /** The question text: claude-agent-acp puts a lone question in the message, several in field descriptions. */
  #getQuestionText = ({ select, input }: ElicitationQuestion) => {
    const field = select ?? input;
    return field?.description || (this.#questions.length === 1 && this.elicitation?.request.message) || field?.title;
  };

  #getAnswerText = ({ select, input }: ElicitationQuestion) => {
    const response = this.elicitation?.response;
    if (response?.action !== 'accept') {
      return i18n.get(response?.action === 'decline' ? 'elicitation.skipped' : 'elicitation.cancelled');
    }
    const picked = select && response.content[select.key];
    const parts = [
      ...(select?.choices.filter((choice) => isSelected(picked, choice)).map((choice) => choice.title) ?? []),
      ...(input && response.content[input.key] !== undefined ? [String(response.content[input.key])] : []),
    ];
    return parts.length ? parts.join(', ') : i18n.get('elicitation.unanswered');
  };

  #renderAnswered = () => html`
    <section class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-light px-4 py-3">
      ${this.#questions.map(
        (question) => html`
          <div class="select-text text-sm leading-relaxed break-words">
            <p class="m-0 whitespace-pre-wrap text-describe">${this.#getQuestionText(question)}</p>
            <p class="m-0 mt-0.5 font-medium whitespace-pre-wrap text-highlight">${this.#getAnswerText(question)}</p>
          </div>
        `,
      )}
    </section>
  `;

  @template()
  #render = () => {
    if (!this.elicitation) return html``;
    const { request, response } = this.elicitation;
    if (response) return this.#renderAnswered();
    const content = getElicitationContent(this.#questions, this.#state.draft);
    return html`
      <section class="overflow-hidden rounded-2xl border border-notice/70 bg-bg-light">
        <div class="flex flex-col gap-4 px-4 pt-3 pb-3.5">
          <h2 class="select-text m-0 text-sm font-semibold leading-relaxed whitespace-pre-wrap text-highlight">${request.message}</h2>
          ${this.#questions.map(this.#renderQuestion)}
        </div>
        <footer class="flex gap-2 border-t border-border px-3 py-2.5">
          <button class="${button} border-border bg-bg-light text-describe" @click=${() => this.respond({ action: 'decline' })}>
            ${i18n.get('elicitation.skip')}
          </button>
          <button
            class="${button} border-primary bg-primary text-white"
            ?disabled=${!content}
            @click=${() => content && this.respond({ action: 'accept', content })}
          >
            ${i18n.get('elicitation.submit')}
          </button>
        </footer>
      </section>
    `;
  };
}
