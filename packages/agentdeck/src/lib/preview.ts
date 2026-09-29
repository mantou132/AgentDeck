import { convertFileSrc, isTauri } from '@tauri-apps/api/core';

const PREVIEW_SCHEME = 'agentdeck-preview';

/** Only the App registers the `agentdeck-preview` protocol serving host files. */
export const previewSupported = isTauri();

// Site roots by URL host; hosts are short ids since host paths are not valid hostnames.
const roots = new Map<string, string>();
const hosts = new Map<string, string>();

export const isAbsoluteHostPath = (path: string) => /^(\/|[a-z]:[\\/])/i.test(path);

/** URL serving a host file; its directory is the site root, so a build's root-absolute URLs resolve inside it. */
export const toPreviewUrl = (file: string) => {
  const normalized = file.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  const root = normalized.slice(0, slash);
  let host = hosts.get(root);
  if (!host) {
    host = `p${hosts.size}`;
    hosts.set(root, host);
    roots.set(host, root);
  }
  const probe = new URL(convertFileSrc('', PREVIEW_SCHEME));
  // Android / Windows expose custom protocols as `http(s)://<scheme>.<host>`.
  const origin =
    probe.protocol === `${PREVIEW_SCHEME}:`
      ? `${PREVIEW_SCHEME}://${host}`
      : `${probe.protocol}//${PREVIEW_SCHEME}.${host}`;
  return `${origin}/${encodeURIComponent(normalized.slice(slash + 1))}`;
};

/** Host file a preview request asks for; undefined when outside its site root. */
export const resolvePreviewPath = (url: string) => {
  const { hostname, pathname } = new URL(url);
  const root = roots.get(hostname.replace(`${PREVIEW_SCHEME}.`, ''));
  if (root === undefined) return;
  const path = decodeURIComponent(pathname);
  // Encoded slashes survive URL normalization and could climb out of the root.
  if (path.split('/').includes('..')) return;
  return `${root}${path.endsWith('/') ? `${path}index.html` : path}`;
};
