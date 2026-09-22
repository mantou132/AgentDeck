import { popularAgents } from 'agentdeck/config';

// Aligned with AgentDeck and ACP Registry:
// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
export const POPULAR_AGENTS = popularAgents.map(({ id, name }) => ({
  id,
  name,
  icon: `https://cdn.agentclientprotocol.com/registry/v1/latest/${id}.svg`,
}));

export function getAgentIconUrl(agentId) {
  const popular = POPULAR_AGENTS.find((agent) => agent.id === agentId);
  if (popular?.icon) return popular.icon;
  return `https://cdn.agentclientprotocol.com/registry/v1/latest/${agentId}.svg`;
}

export function getAgentName(agentId) {
  const popular = POPULAR_AGENTS.find((agent) => agent.id === agentId);
  return popular?.name || agentId;
}
