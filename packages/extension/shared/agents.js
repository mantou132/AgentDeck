import { popularAgents } from 'agentdeck/config';

// Aligned with AgentDeck and ACP Registry:
// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
// The built-in `free` agent runs OpenCode and has no registry icon.
const registryIcon = (id) =>
  `https://cdn.agentclientprotocol.com/registry/v1/latest/${id === 'free' ? 'opencode' : id}.svg`;

export const POPULAR_AGENTS = popularAgents.map(({ id, name }) => ({
  id,
  name,
  icon: registryIcon(id),
}));

export function getAgentIconUrl(agentId) {
  const popular = POPULAR_AGENTS.find((agent) => agent.id === agentId);
  if (popular?.icon) return popular.icon;
  return registryIcon(agentId);
}

export function getAgentName(agentId) {
  const popular = POPULAR_AGENTS.find((agent) => agent.id === agentId);
  return popular?.name || agentId;
}
