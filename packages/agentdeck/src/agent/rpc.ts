type ResumeCallHandlers = {
  onEvent?: (event: unknown) => void | Promise<void>;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
};

export type RpcId = string | number;

export type CallOptions = { timeoutMs: number; timeoutMessage: string };

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
  onEvent?: (event: unknown) => void | Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

type Handler = (params: unknown) => unknown | Promise<unknown>;

export class RpcPeer {
  #send: (message: RpcMessage) => void | Promise<void>;
  #onTimeout?: (id: RpcId) => void | Promise<void>;
  #pending = new Map<RpcId, PendingCall>();
  #handlers = new Map<string, Handler>();
  #notifyHandlers = new Map<string, Handler>();

  constructor(send: (message: RpcMessage) => void | Promise<void>, onTimeout?: (id: RpcId) => void | Promise<void>) {
    this.#send = send;
    this.#onTimeout = onTimeout;
  }

  call = <T>(
    method: string,
    params: unknown = {},
    onEvent?: (event: unknown) => void | Promise<void>,
    options?: CallOptions,
    callId?: RpcId,
  ) => {
    // Replies from before an App reload must never match a new call unless explicitly resumed.
    const id = callId ?? crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = { resolve: resolve as (value: unknown) => void, reject, onEvent };
      this.#pending.set(id, pending);
      if (options) {
        pending.timer = setTimeout(() => {
          if (!this.#takePending(id)) return;
          reject(new Error(options.timeoutMessage));
          Promise.resolve()
            .then(() => this.#onTimeout?.(id))
            .catch(console.error);
        }, options.timeoutMs);
      }
      const failed = (error: unknown) => {
        this.#takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      };
      try {
        Promise.resolve(this.#send({ id, method, params })).catch(failed);
      } catch (error) {
        failed(error);
      }
    });
  };

  resumeCall = (id: RpcId, handlers: ResumeCallHandlers) => {
    this.#pending.set(id, {
      resolve: handlers.resolve ?? (() => {}),
      reject: handlers.reject ?? (() => {}),
      onEvent: handlers.onEvent,
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

      Promise.resolve(result).then(
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
          return pending.onEvent?.(message.event);
        } catch (error) {
          this.#takePending(id);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      this.#takePending(id);
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
      Promise.resolve(result).catch((error) => console.error(`RPC notification failed: ${method}`, error));
    }
  };

  rejectAll = (error: Error) => {
    for (const id of this.#pending.keys()) this.#takePending(id)?.reject(error);
  };

  #takePending = (id: RpcId) => {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    clearTimeout(pending?.timer);
    return pending;
  };

  #post = (message: RpcMessage) => {
    Promise.resolve()
      .then(() => this.#send(message))
      .catch(console.error);
  };
}
