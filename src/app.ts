import { agentdeckStore } from './store';

@customElement('agentdeck-app')
@connectStore(agentdeckStore)
export class AgentDeckAppElement extends GemElement {
  @template()
  #render = () => html`
    <agentdeck-session-list-page v-if=${!!agentdeckStore.settings.relayId} class="block h-full"></agentdeck-session-list-page>
    <agentdeck-settings-page v-else class="block h-full"></agentdeck-settings-page>
  `;
}
