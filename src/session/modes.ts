import type { SessionConfigOption } from '../agent/api';
import type { SessionOptions } from './types';

export type ModeSelection = {
  currentValue: string;
  configId?: string;
  choices: { value: string; name: string; description?: string | null }[];
};

const isModeOption = (option: SessionConfigOption) => option.category === 'mode' || option.id === 'mode';

export const getModeSelection = (options?: SessionOptions): ModeSelection | undefined => {
  if (options?.modes?.availableModes.length) {
    return {
      currentValue: options.modes.currentModeId,
      choices: options.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    };
  }
  const option = options?.configOptions?.find(isModeOption);
  if (option?.type !== 'select') return;
  const choices = option.options.flatMap((item) => ('options' in item ? item.options : [item]));
  if (!choices.length) return;
  return { currentValue: option.currentValue, configId: option.id, choices };
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
