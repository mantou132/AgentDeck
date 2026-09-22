const style = css`
  :host(:where(:not([hidden]))) {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5em;
  }

  agent-icon {
    width: 1em;
    height: 1em;
    flex-shrink: 0;
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

@customElement('agent-session-option-label')
@adoptedStyle(style)
@shadow()
class AgentSessionOptionLabelElement extends GemElement {
  @property sessionAgent;
  @property sessionTitle;

  @template()
  #content = () => html`
    <agent-icon .agent=${this.sessionAgent}></agent-icon>
    <span>${this.sessionTitle}</span>
  `;
}
