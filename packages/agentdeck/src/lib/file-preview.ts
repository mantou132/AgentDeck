export const MAX_CODE_BLOCK_LENGTH = 100_000;

export const isSmallTextFile = (text: string) => text.length <= MAX_CODE_BLOCK_LENGTH;

export const getCodeLang = (path: string) => path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || '';

const mimeTypes: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

/** Share targets on Android filter by MIME type; unknown types fall back to the plugin's `application/octet-stream`. */
export const getMimeType = (path: string) => mimeTypes[getCodeLang(path)] || '';
