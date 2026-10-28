import { defaultAgents } from 'agentdeck/config';

export const AGENTS = defaultAgents;

// Aligned with AgentDeck and ACP Registry:
// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
// The built-in `free` agent runs OpenCode and has no registry icon.
export const getAgentIconUrl = (agentId: string) =>
  `https://cdn.agentclientprotocol.com/registry/v1/latest/${agentId === 'free' ? 'opencode' : agentId}.svg`;

export const getAgentName = (agentId: string) => AGENTS.find((agent) => agent.id === agentId)?.name || agentId;
