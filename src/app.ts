import { icons } from '@mantou/tap-ui/lib/icons';

import { routes } from './routes';

@customElement('flowday-app')
export class FlowdayRootElement extends GemElement {
  @template()
  #render = () => html`
    <tap-page>
      <tap-route .routes=${routes}></tap-route>
      <tap-tabbar
        slot="footer"
        .items=${[
          { label: '今日', path: '/', pattern: '/', icon: icons.menu },
          { label: '收藏', path: '/starred', pattern: '/starred', icon: icons.star },
          { label: '设置', path: '/settings', pattern: '/settings', icon: icons.tune },
        ]}
      ></tap-tabbar>
    </tap-page>
  `;
}
