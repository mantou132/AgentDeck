import type { RpcMessage } from './rpc';
import { RpcPeer } from './rpc';

export type RemoteAgent = { id: string; name: string };

export type RemoteSession = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  additionalDirectories?: string[];
};

export type SessionEvent =
  | { event: 'session_update'; update: Record<string, unknown> }
  | { event: 'stop'; stop_reason?: string };

export type LoadedSession = {
  agent: string;
  sessionId: string;
  title?: string;
  updatedAt?: string;
  modes?: unknown;
  configOptions?: unknown[];
};

export type PermissionRequest = {
  agent: string;
  sessionId: string;
  toolCall?: { title?: string; kind?: string; rawInput?: unknown };
  options?: { optionId: string; name: string; kind?: string }[];
};

export type CreatedSession = {
  agent?: string;
  sessionId?: string;
  title?: string;
  updatedAt?: string;
  modes?: unknown;
  configOptions?: unknown[];
};

type ListResponse = { sessions?: RemoteSession[]; nextCursor?: string };

export class AgentApi {
  #peer: RpcPeer;

  constructor(send: (message: RpcMessage) => void) {
    this.#peer = new RpcPeer(send);
  }

  dispatch = (message: RpcMessage) => this.#peer.dispatch(message);

  rejectAll = (error: Error) => this.#peer.rejectAll(error);

  setPermissionHandler = (handler: (request: PermissionRequest) => Promise<string>) =>
    this.#peer.handle('agent_permission_request', (params) =>
      handler(params as PermissionRequest).then((optionId) => ({ optionId })),
    );

  setSessionEndedHandler = (handler: (params: { agent: string; sessionId: string }) => void) =>
    this.#peer.onNotify('agent_session_ended', (params) => handler(params as { agent: string; sessionId: string }));

  setHostReconnectedHandler = (handler: () => void) => this.#peer.onNotify('host_reconnected', () => handler());

  attachPeer = async (deviceId: string) => {
    return this.#peer.call<{ peerId: number }>('peer_attach', { deviceId });
  };

  listAgents = async () => {
    const result = await this.#peer.call<{ agents?: RemoteAgent[] }>('agent_list');
    return Array.isArray(result.agents) ? result.agents : [];
  };

  completeCwd = async (input: string) => {
    const result = await this.#peer.call<{
      value?: string;
      isDirectory?: boolean;
      directories?: string[];
    }>('agent_cwd_complete', { input, limit: 50 });
    return {
      value: typeof result.value === 'string' ? result.value : '',
      isDirectory: result.isDirectory === true,
      directories: Array.isArray(result.directories)
        ? result.directories.filter((item) => typeof item === 'string')
        : [],
    };
  };

  createSession = ({ agent, cwd }: { agent: string; cwd: string }) =>
    this.#peer.call<CreatedSession>('agent_session_create', { agent, cwd });

  listSessions = async (agent: string) => {
    const sessions: RemoteSession[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.#peer.call<ListResponse>('agent_session_list', {
        agent,
        ...(cursor ? { cursor } : {}),
      });
      if (Array.isArray(result.sessions)) sessions.push(...result.sessions);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('远端 Agent 返回了重复的 session cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return sessions;
  };

  loadSession = (session: RemoteSession, agent: string, onEvent: (event: SessionEvent) => void) =>
    this.#peer.call<LoadedSession>(
      'agent_session_load',
      { agent, sessionId: session.sessionId, cwd: session.cwd, stream: true },
      (event) => onEvent(event as SessionEvent),
    );

  prompt = (sessionId: string, agent: string, prompt: string, onEvent: (event: SessionEvent) => void) =>
    this.#peer.call<{ answer?: string }>('agent_prompt', { agent, sessionId, prompt, stream: true }, (event) =>
      onEvent(event as SessionEvent),
    );

  cancelPrompt = (sessionId: string, agent: string) =>
    this.#peer.call<{ cancelled?: boolean }>('agent_prompt_cancel', { agent, sessionId });

  closeSession = (agent: string, sessionId: string) =>
    this.#peer.call<{ closed?: boolean }>('agent_session_close', { agent, sessionId });
}
