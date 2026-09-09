import { toWebproxyUrl } from 'tauri-plugin-edge-to-edge-api';

export type MessageLink = { type: 'web'; url: string } | { type: 'file'; path: string; line?: number };

// Use the raw href: the browser would resolve relative files against the app URL.
export const parseMessageLink = (href: string): MessageLink | undefined => {
  const value = href.trim();
  if (!value || value.startsWith('#')) return;
  if (/^(https?:)?\/\//i.test(value)) {
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      return { type: 'web', url: toWebproxyUrl(url.href) };
    } catch {
      return;
    }
  }

  let path = value;
  let hash = '';
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return;
      path = url.pathname;
      hash = url.hash;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return;
    }
  } else {
    const hashIndex = path.indexOf('#');
    if (hashIndex !== -1) {
      hash = path.slice(hashIndex);
      path = path.slice(0, hashIndex);
    }
  }
  const suffix = /:(\d+)(?::\d+)?$/.exec(path);
  if (suffix) path = path.slice(0, suffix.index);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Literal percent signs are valid in local filenames.
  }
  if (!path) return;
  const line = Number(/^#L?(\d+)/i.exec(hash)?.[1] || suffix?.[1]);
  return { type: 'file', path, ...(line > 0 ? { line } : {}) };
};
