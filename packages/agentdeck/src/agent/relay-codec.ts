import { i18n } from '../i18n';
import { createRelayEncryption, type RelayEncryption } from './encryption';
import type { RpcMessage } from './rpc';

/** Relay's WebSocket message limit, including the frame envelope. */
const MAX_FRAME_BYTES = 10 * 1024 * 1024;

/**
 * Converts RPC messages to Relay payloads and back: optional end-to-end
 * encryption, the Relay frame size limit, and binary replies. Knows nothing
 * about the outbox or the host session.
 */
export class RelayCodec {
  /** Relay channel id: the pairing id itself for plain UUIDs, otherwise derived. */
  readonly routeId: string;
  #encryption: RelayEncryption | undefined;

  constructor(relayId: string, deviceId: string) {
    this.#encryption = createRelayEncryption(relayId, deviceId);
    this.routeId = this.#encryption?.routeId ?? relayId;
  }

  /** Encodes an outgoing message, rejecting it if the whole Relay frame would exceed the limit. */
  encode(message: RpcMessage, ephemeral: boolean, messageId: string): unknown {
    let payload: unknown;
    try {
      payload = this.#encryption ? this.#encryption.seal(message) : message;
    } catch {
      throw new Error(i18n.get('error.encryptionFailed'));
    }
    const frame = JSON.stringify({ type: 'message', message_id: messageId, payload, ...(ephemeral && { ephemeral }) });
    if (new TextEncoder().encode(frame).byteLength > MAX_FRAME_BYTES) {
      throw new Error(i18n.get('error.messageTooLarge'));
    }
    return payload;
  }

  /** Reads back an encoded outgoing payload, to match outbox entries with their RPC. */
  readOutgoing(payload: unknown): RpcMessage {
    return (this.#encryption ? this.#encryption.readOutgoing(payload) : payload) as RpcMessage;
  }

  decode(payload: unknown): RpcMessage {
    if (!this.#encryption) return payload as RpcMessage;
    try {
      return this.#encryption.open(payload).message as RpcMessage;
    } catch {
      throw new Error(i18n.get('error.decryptionFailed'));
    }
  }

  /**
   * Decodes a host binary reply, `[u32 big-endian header length][reply JSON][bytes]`,
   * into the JSON reply shape, with the bytes as `result.data`.
   */
  decodeBinary(data: Uint8Array): RpcMessage {
    let bytes = data;
    if (this.#encryption) {
      try {
        bytes = this.#encryption.openBytes(data);
      } catch {
        throw new Error(i18n.get('error.decryptionFailed'));
      }
    }
    const headerEnd = 4 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const message = JSON.parse(new TextDecoder().decode(bytes.subarray(4, headerEnd))) as RpcMessage & {
      result: Record<string, unknown>;
    };
    message.result.data = bytes.slice(headerEnd);
    return message;
  }
}
