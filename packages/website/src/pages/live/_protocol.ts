/**
 * AgentDeck Live, audience side: relay frames, AES-GCM sealing and the messages inside them. The presenter side is
 * `live.js` shared by the courseware and presentation skill templates (packages/agentdeck/skills/_shared/deck); keep
 * both in step.
 */

export type Sealed = { iv: string; c: string };

export type PresenterSlide = {
  index: number;
  title: string;
  notes: string;
};

/** Audience or Presenter phone → presenter host. */
export type AudienceMessage =
  | { t: 'join'; from: string }
  | { t: 'data'; from: string; value: unknown }
  | { t: 'presenter_join'; from: string; key: string }
  | { t: 'cmd'; from: string; op: 'next' | 'prev' | 'go'; index?: number };

/** Presenter host → audience or presenter phone. */
export type PresenterMessage =
  | { t: 'view'; html: string }
  | { t: 'data'; value: unknown }
  | { t: 'hello'; n: number }
  | { t: 'notice'; text: string }
  /** The presenter (re)connected; answer with `join`. */
  | { t: 'present' }
  | { t: 'presenter_init'; current: number; total: number; slides: PresenterSlide[] }
  | { t: 'presenter_sync'; index: number };

export type RelayFrame =
  | { type: 'ready' }
  | { type: 'ephemeral' | 'message'; payload: Sealed }
  | { type: 'undeliverable'; message_id: string }
  | { type: 'error'; message?: string };

/** The relay serves `/ws` on the site's own host (see CLAUDE.md, Deployment). */
export const relayUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const unb64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const randomId = (length: number) => b64url(crypto.getRandomValues(new Uint8Array(length)));

/** Reads `#<room>.<key>` or `#<room>.<key>.<presenterKey>`; undefined when the link is incomplete. */
export const parseFragment = (hash: string) => {
  const match = /^#([\w-]{16,64})\.([\w-]{43})(?:\.([\w-]{16,64}))?$/.exec(hash);
  return match ? { room: match[1], key: match[2], presenterKey: match[3] } : undefined;
};

export const importKey = (raw: string) =>
  crypto.subtle.importKey('raw', unb64url(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

export const seal = async (key: CryptoKey, message: AudienceMessage): Promise<Sealed> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(message));
  return { iv: b64url(iv), c: b64url(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data))) };
};

export const unseal = async (key: CryptoKey, sealed: Sealed) => {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(sealed.iv) }, key, unb64url(sealed.c));
  return JSON.parse(new TextDecoder().decode(data)) as PresenterMessage;
};
