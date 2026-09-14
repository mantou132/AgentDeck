export const MAX_CODE_BLOCK_LENGTH = 100_000;

export const isSmallTextFile = (text: string) => text.length <= MAX_CODE_BLOCK_LENGTH;

export const getCodeLang = (path: string) => path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || '';
