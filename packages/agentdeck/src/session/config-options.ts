import type { ConfigChoice, SessionConfigOption } from '../agent/api';
import { i18n } from '../i18n';
import type { SessionOptions } from './types';

/** Optional session configuration (mode / model / effort...); `legacyMode` comes from ACP legacy `modes`, switched via `set_mode`. */
export type ConfigSelect = {
  id: string;
  name: string;
  category?: string | null;
  currentValue: string;
  choices: ConfigChoice[];
  legacyMode?: boolean;
};

const isModeOption = (option: SessionConfigOption) => option.category === 'mode' || option.id === 'mode';

export const getConfigSelects = (options?: SessionOptions): ConfigSelect[] => {
  const modes = options?.modes?.availableModes.length ? options.modes : undefined;
  const selects: ConfigSelect[] = modes
    ? [
        {
          id: 'mode',
          name: i18n.get('composer.mode'),
          currentValue: modes.currentModeId,
          choices: modes.availableModes.map((mode) => ({
            value: mode.id,
            name: mode.name,
            description: mode.description,
          })),
          category: 'mode',
          legacyMode: true,
        },
      ]
    : [];
  for (const option of options?.configOptions ?? []) {
    // When modes are reported concurrently, mode-like config options are duplicate
    if (option.type !== 'select' || (modes && isModeOption(option))) continue;
    const choices = option.options.flatMap((item) => ('options' in item ? item.options : [item]));
    if (!choices.length) continue;
    const { id, name, category, currentValue } = option;
    selects.push({ id, name, category, currentValue, choices });
  }
  return selects;
};

export const isModelSelect = (select: ConfigSelect) => select.category === 'model' || select.id === 'model';

/** Composer displays only the current model; shows first item when no model option exists. */
export const getConfigLabel = (selects: ConfigSelect[]) => {
  const select = selects.find(isModelSelect) ?? selects[0];
  return select?.choices.find((choice) => choice.value === select.currentValue)?.name ?? '';
};

export const withCurrentMode = (options: SessionOptions, modeId: string): SessionOptions => ({
  ...(options.modes ? { modes: { ...options.modes, currentModeId: modeId } } : {}),
  ...(options.configOptions
    ? {
        configOptions: options.configOptions.map((option) =>
          isModeOption(option) && option.type === 'select' ? { ...option, currentValue: modeId } : option,
        ),
      }
    : {}),
});

export const withConfigValue = (options: SessionOptions, select: ConfigSelect, value: string): SessionOptions =>
  select.legacyMode
    ? withCurrentMode(options, value)
    : {
        ...options,
        configOptions: options.configOptions?.map((option) =>
          option.id === select.id && option.type === 'select' ? { ...option, currentValue: value } : option,
        ),
      };
