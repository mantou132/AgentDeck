import { contentsContainer } from '@mantou/tap-ui/lib/styles';

@customElement('flowday-settings')
@adoptedStyle(contentsContainer)
export class FlowdaySettingsElement extends GemElement {
  @template()
  #render = () => html`
    <tap-page>
      <tap-navbar slot="header" title="设置"></tap-navbar>
      <tap-cell-group
        heading="关于"
        .items=${[
          { label: '版本', description: '0.1.0' },
          { label: 'Flowday', description: '极简移动端任务清单' },
        ]}
      ></tap-cell-group>
    </tap-page>
  `;
}
