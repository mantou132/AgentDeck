import type {
  ElicitationOption,
  ElicitationProperty,
  ElicitationRequest,
  ElicitationResponse,
  ElicitationValue,
} from '../agent/api';
import { i18n } from '../i18n';

/** A form elicitation shown in the timeline; `response` is set once it is answered, skipped or cancelled. */
export type Elicitation = { request: ElicitationRequest; response?: ElicitationResponse };

export type ElicitationChoice = { value: string | boolean; title: string; description?: string };

type FieldBase = { key: string; title?: string; description?: string; required: boolean };

export type ElicitationSelect = FieldBase & { kind: 'single' | 'multi'; choices: ElicitationChoice[] };

export type ElicitationInput = FieldBase & { kind: 'text' | 'number' | 'integer' };

/** A select and the text field right after it, which is its "Other" answer (claude-agent-acp `question_<n>_custom`). */
export type ElicitationQuestion = { select?: ElicitationSelect; input?: ElicitationInput };

/** Values being edited: select values as given, input values as typed text. */
export type ElicitationDraft = Record<string, ElicitationValue | undefined>;

const toChoices = (options?: ElicitationOption[], values?: string[]): ElicitationChoice[] =>
  options?.map(({ const: value, title, description }) => ({ value, title: title || value, description })) ??
  values?.map((value) => ({ value, title: value })) ??
  [];

const toField = (
  key: string,
  property: ElicitationProperty,
  required: boolean,
): ElicitationSelect | ElicitationInput => {
  const base = { key, title: property.title, description: property.description, required };
  switch (property.type) {
    case 'array':
      return { ...base, kind: 'multi', choices: toChoices(property.items?.anyOf, property.items?.enum) };
    case 'boolean':
      return {
        ...base,
        kind: 'single',
        choices: [
          { value: true, title: i18n.get('elicitation.yes') },
          { value: false, title: i18n.get('elicitation.no') },
        ],
      };
    case 'number':
    case 'integer':
      return { ...base, kind: property.type };
    default:
      return property.oneOf || property.enum
        ? { ...base, kind: 'single', choices: toChoices(property.oneOf, property.enum) }
        : { ...base, kind: 'text' };
  }
};

export const getElicitationQuestions = ({ requestedSchema }: ElicitationRequest) => {
  const required = new Set(requestedSchema.required);
  const questions: ElicitationQuestion[] = [];
  for (const [key, property] of Object.entries(requestedSchema.properties)) {
    const field = toField(key, property, required.has(key));
    const last = questions.at(-1);
    if ('choices' in field) questions.push({ select: field });
    else if (field.kind === 'text' && last?.select && !last.input) last.input = field;
    else questions.push({ input: field });
  }
  return questions;
};

const isEmpty = (value: ElicitationValue | undefined) =>
  value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);

/** Accept content for the filled fields; `undefined` while a required field is empty or nothing is filled. */
export const getElicitationContent = (questions: ElicitationQuestion[], draft: ElicitationDraft) => {
  const content: Record<string, ElicitationValue> = {};
  for (const field of questions.flatMap(({ select, input }) => [select, input])) {
    if (!field) continue;
    const value = draft[field.key];
    if (isEmpty(value)) {
      if (field.required) return;
      continue;
    }
    if (field.kind === 'number' || field.kind === 'integer') {
      const number = Number(value);
      if (Number.isNaN(number)) return;
      content[field.key] = number;
    } else {
      content[field.key] = typeof value === 'string' ? value.trim() : (value as ElicitationValue);
    }
  }
  return Object.keys(content).length ? content : undefined;
};

/** Sessions with a question waiting for the user. */
export const hasPendingElicitation = (elicitations: Elicitation[] = []) =>
  elicitations.some((elicitation) => !elicitation.response);
