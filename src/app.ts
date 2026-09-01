import { agentdeckStore } from './session-store';

@customElement('agentdeck-app')
@connectStore(agentdeckStore)
export class AgentDeckAppElement extends GemElement {
  @template()
  #render = () => html`
    <agentdeck-menu-page v-if=${!!agentdeckStore.settings.relayId} class="block h-full"></agentdeck-menu-page>
    <agentdeck-settings-page v-else class="block h-full"></agentdeck-settings-page>
  `;
}
