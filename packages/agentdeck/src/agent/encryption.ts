import { arrayBufferToBase64, base64ToArrayBuffer } from '@mantou/tap-ui/lib/encode';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const PREFIX = 'adk1_';
const PROTOCOL = 'agentdeck-e2ee-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const encodeBase64 = (bytes: Uint8Array): string => {
  let text = '';
  // Tap UI spreads each buffer into function arguments. Keep chunks small and
  // divisible by three so their Base64URL encodings concatenate without padding.
  for (let offset = 0; offset < bytes.length; offset += 32766) {
    text += arrayBufferToBase64(bytes.slice(offset, offset + 32766).buffer, true);
  }
  return text;
};

const decodeBase64 = (text: string): Uint8Array => {
  if (!/^[\w-]+$/.test(text)) throw new Error('Invalid encrypted message encoding');
  return new Uint8Array(base64ToArrayBuffer(text));
};

export const isPairingId = (id: string): boolean => {
  if (uuidPattern.test(id)) return true;
  if (!id.startsWith(PREFIX) || id.length !== PREFIX.length + 43) return false;
  try {
    return decodeBase64(id.slice(PREFIX.length)).length === 32;
  } catch {
    return false;
  }
};

type Envelope = { e2ee: number; sender: string; nonce: string; ciphertext: string };

// The pairing secret never becomes a Relay URL, room ID, or outbox field.
export class RelayEncryption {
  readonly routeId: string;
  #sendKey: Uint8Array;
  #receiveKey: Uint8Array;
  #sender: string;
  #direction: string;
  #receiveDirection: string;

  constructor(id: string, role: 'app' | 'host', sender: string) {
    if (!id.startsWith(PREFIX) || !isPairingId(id)) throw new Error('Invalid encrypted pairing ID');
    const secret = decodeBase64(id.slice(PREFIX.length));
    const derive = (label: string) => hkdf(sha256, secret, encoder.encode(PROTOCOL), encoder.encode(label), 32);
    this.routeId = `adr1_${encodeBase64(derive('route'))}`;
    this.#direction = role === 'app' ? 'app-to-host' : 'host-to-app';
    this.#receiveDirection = role === 'app' ? 'host-to-app' : 'app-to-host';
    this.#sendKey = derive(this.#direction);
    this.#receiveKey = derive(this.#receiveDirection);
    secret.fill(0);
    this.#sender = sender;
  }

  #aad = (frame: Envelope, direction: string) =>
    encoder.encode(JSON.stringify([PROTOCOL, this.routeId, direction, frame.sender]));

  seal = (message: unknown): Envelope => {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const frame: Envelope = { e2ee: 1, sender: this.#sender, nonce: encodeBase64(nonce), ciphertext: '' };
    frame.ciphertext = encodeBase64(
      xchacha20poly1305(this.#sendKey, nonce, this.#aad(frame, this.#direction)).encrypt(
        encoder.encode(JSON.stringify(message)),
      ),
    );
    return frame;
  };

  #decrypt = (value: unknown, key: Uint8Array, direction: string): { sender: string; message: unknown } => {
    const frame = value as Envelope;
    if (
      frame?.e2ee !== 1 ||
      typeof frame.sender !== 'string' ||
      !frame.sender ||
      frame.sender.length > 256 ||
      typeof frame.nonce !== 'string' ||
      typeof frame.ciphertext !== 'string' ||
      (direction === 'host-to-app' && frame.sender !== 'host') ||
      (direction === 'app-to-host' && frame.sender === 'host')
    )
      throw new Error('Invalid encrypted message');
    const nonce = decodeBase64(frame.nonce);
    if (nonce.length !== 24) throw new Error('Invalid encrypted message nonce');
    const plaintext = xchacha20poly1305(key, nonce, this.#aad(frame, direction)).decrypt(
      decodeBase64(frame.ciphertext),
    );
    const message = JSON.parse(decoder.decode(plaintext));
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid encrypted RPC');
    return { sender: frame.sender, message };
  };

  // Used only locally to correlate encrypted outbox entries with RPC deadlines/rejections.
  readOutgoing = (value: unknown): unknown => this.#decrypt(value, this.#sendKey, this.#direction).message;

  open = (value: unknown) => this.#decrypt(value, this.#receiveKey, this.#receiveDirection);
}

export const createRelayEncryption = (id: string, sender: string): RelayEncryption | undefined => {
  if (!isPairingId(id)) throw new Error('Invalid pairing ID');
  if (!id.startsWith(PREFIX)) return;
  return new RelayEncryption(id, 'app', sender);
};
