type RpcId = string | number;

export type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  event?: unknown;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: (event: unknown) => void;
};

type Handler = (params: unknown) => unknown | Promise<unknown>;

export class RpcPeer {
  #send: (message: RpcMessage) => void;
  #pending = new Map<RpcId, PendingCall>();
  #handlers = new Map<string, Handler>();
  #notifyHandlers = new Map<string, Handler>();

  constructor(send: (message: RpcMessage) => void) {
    this.#send = send;
  }

  call = <T>(method: string, params: unknown = {}, onEvent?: (event: unknown) => void) => {
    // Replies from before an App reload must never match a new call.
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onEvent });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  handle = (method: string, handler: Handler) => this.#handlers.set(method, handler);

  onNotify = (method: string, handler: Handler) => this.#notifyHandlers.set(method, handler);

  dispatch = (message: RpcMessage) => {
    const { id, method } = message;
    if (id !== undefined && method !== undefined) {
      const handler = this.#handlers.get(method);
      if (!handler) {
        this.#post({ id, error: `Unknown method: ${method}` });
        return;
      }

      let result: unknown | Promise<unknown>;
      try {
        result = handler(message.params);
      } catch (error) {
        this.#post({ id, error: error instanceof Error ? error.message : String(error) });
        return;
      }

      void Promise.resolve(result).then(
        (value) => this.#post({ id, result: value ?? null }),
        (error) => this.#post({ id, error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    if (id !== undefined) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      if ('event' in message) {
        try {
          pending.onEvent?.(message.event);
        } catch (error) {
          this.#pending.delete(id);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      this.#pending.delete(id);
      if (typeof message.error === 'string') pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (method !== undefined) {
      const handler = this.#notifyHandlers.get(method);
      if (!handler) return;
      let result: unknown | Promise<unknown>;
      try {
        result = handler(message.params);
      } catch (error) {
        console.error(`RPC notification failed: ${method}`, error);
        return;
      }
      void Promise.resolve(result).catch((error) => console.error(`RPC notification failed: ${method}`, error));
    }
  };

  rejectAll = (error: Error) => {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  };

  #post = (message: RpcMessage) => {
    this.#send(message);
  };
}
