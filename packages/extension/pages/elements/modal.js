import { DuoyunModalElement } from 'duoyun-ui/elements/modal';
import { theme } from 'duoyun-ui/lib/theme';

const style = css`
  :host {
    background-color: color-mix(in srgb, ${theme.backgroundColor} 90%, transparent);
  }

  .mask {
    background-color: transparent;
  }
`;

@customElement('agent-modal')
@adoptedStyle(style)
class AgentModalElement extends DuoyunModalElement {}
