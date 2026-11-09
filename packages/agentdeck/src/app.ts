import { activityStore } from '@mantou/tap-ui/lib/decorators';
import { i18n } from './i18n';
import { getOpenSessionId } from './navigation';
import { isSplitView, layoutStore } from './state/layout';
import { agentdeckStore, sessionsStore } from './state/store';
import { icons } from './styles/icons';

/** Root page of the global Stack; in the split view the list moves beside the Stack. */
@customElement('agentdeck-home')
@connectStore(agentdeckStore)
@connectStore(layoutStore)
export class AgentDeckHomeElement extends GemElement {
  @template()
  #render = () => {
    if (!agentdeckStore.settings.relayId) {
      return html`<agentdeck-settings-page class="block h-full"></agentdeck-settings-page>`;
    }
    if (!isSplitView()) {
      return html`<agentdeck-session-list-page class="block h-full"></agentdeck-session-list-page>`;
    }
    return html`
      <section class="grid h-full place-items-center content-center bg-bg px-8 text-center">
        <div class="grid size-14 place-items-center rounded-[18px] border border-border bg-bg-light shadow-card">
          <tap-use class="size-6 text-describe" .element=${icons.messageSquare}></tap-use>
        </div>
        <p class="mt-4 mb-0 text-sm text-describe">${i18n.get('sessionList.selectSession')}</p>
      </section>
    `;
  };
}

const style = css`
  :scope {
    --sidebar-width: 320px;
    --content-left: 320px;
  }
  /* Each side on its own screen of a dual-screen device, clear of the hinge */
  @media (horizontal-viewport-segments: 2) {
    :scope {
      --sidebar-width: env(viewport-segment-width 0 0);
      --content-left: env(viewport-segment-left 1 0);
    }
  }
  .sidebar {
    position: absolute;
    inset-block: 0;
    left: 0;
    width: var(--sidebar-width);
  }
  .content {
    position: absolute;
    inset: 0;
  }
  .content.split {
    left: var(--content-left);
  }
`;

/** Rendered by `initApp` beside the global Stack, which it owns. */
@customElement('agentdeck-app')
@adoptedStyle(style)
@connectStore(agentdeckStore)
@connectStore(layoutStore)
// The highlighted session changes with the pages on the Stack and when a pending session is promoted in place
@connectStore(activityStore)
@connectStore(sessionsStore)
export class AgentDeckAppElement extends GemElement {
  @template()
  #render = () => {
    const split = isSplitView();
    return html`
      <agentdeck-session-list-page
        v-if=${split}
        class="sidebar"
        .activeSessionId=${getOpenSessionId()}
      ></agentdeck-session-list-page>
      <div class=${classMap({ 'content border-border-strong': true, 'split border-l': split })}>
        <tap-stack><agentdeck-home class="block h-full"></agentdeck-home></tap-stack>
      </div>
    `;
  };
}
