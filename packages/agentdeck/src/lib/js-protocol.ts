import { arrayBufferToBase64 } from '@mantou/tap-ui/lib/encode';
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';

// Webview side of `crates/agentdeck/src/js_protocol.rs`, kept free of AgentDeck specifics so it can move into a plugin.

export type ProtocolRequest = {
  url: string;
  /** URL host without the `<scheme>.` prefix Android / Windows add. */
  host: string;
  pathname: string;
  /** Slice to read; absent reads the whole resource. */
  range?: { offset: number; length: number };
};

export type ProtocolResponse = {
  body: Uint8Array | string;
  status?: number;
  /** Guessed from the URL path when absent. */
  contentType?: string;
  /** The whole resource's length, answering a ranged request with 206. */
  size?: number;
};

type NativeRequest = { id: number; url: string; range?: { offset: number; length: number } };

// Android IPC would serialize raw bytes as a JSON number array, so they cross as base64.
const toBase64 = (body: Uint8Array | string) => {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

/** Answers the scheme's requests with `handler`; a throwing handler answers 500. */
export const serve = async (scheme: string, handler: (req: ProtocolRequest) => Promise<ProtocolResponse>) => {
  const channel = new Channel<NativeRequest>(async ({ id, url, range }) => {
    const { hostname, pathname } = new URL(url);
    let response: ProtocolResponse;
    try {
      response = await handler({ url, host: hostname.replace(`${scheme}.`, ''), pathname, range });
    } catch (error) {
      console.warn('Protocol handler failed:', url, error);
      response = { body: '', status: 500 };
    }
    const { body, status = 200, contentType, size } = response;
    await invoke('js_protocol_respond', { id, body: toBase64(body), status, size, contentType });
  });
  await invoke('js_protocol_register', { scheme, channel });
};

/** URL on the scheme; Android / Windows expose custom protocols as `http(s)://<scheme>.<host>`. */
export const protocolUrl = (scheme: string, host: string, path: string) => {
  const probe = new URL(convertFileSrc('', scheme));
  const origin = probe.protocol === `${scheme}:` ? `${scheme}://${host}` : `${probe.protocol}//${scheme}.${host}`;
  return `${origin}${path}`;
};
