const style = css`
  :scope {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  }
  a {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 0 18px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #000;
    text-decoration: none;
    transition: transform 0.15s;
  }
  a:hover {
    transform: translateY(-2px);
  }
  svg {
    width: 24px;
    height: 24px;
    fill: currentColor;
  }
  small {
    display: block;
    font-size: 10px;
    line-height: 1.1;
    opacity: 0.8;
  }
  strong {
    display: block;
    font-size: 17px;
    line-height: 1.15;
  }
`;

@customElement('app-stores')
@adoptedStyle(style)
export class AppStoresElement extends GemElement {
  @template()
  #content = () => html`
    <a href="https://apps.apple.com/app/id6821905390">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.77-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.9 1.15 9.15.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.24-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.39-.92-2.41-3.67zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.28z"
        />
      </svg>
      <span><small>${i18n.get('appStoreSmall')}</small><strong>App Store</strong></span>
    </a>
    <a href="https://play.google.com/store/apps/details?id=com.mantou.agentdeck">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M3.6 1.8c-.3.3-.5.8-.5 1.4v17.6c0 .6.2 1.1.5 1.4l.1.1 9.9-9.9v-.2L3.7 1.7l-.1.1zM16.9 15.6l-3.3-3.3v-.2l3.3-3.3.1.1 3.9 2.2c1.1.6 1.1 1.7 0 2.3l-3.9 2.2h-.1zM17 15.5L13.6 12 3.6 22c.4.4 1 .4 1.7.1l11.7-6.6M17 8.5L5.3 1.9c-.7-.4-1.3-.3-1.7.1l10 10L17 8.5z"
        />
      </svg>
      <span><small>${i18n.get('googlePlaySmall')}</small><strong>Google Play</strong></span>
    </a>
  `;
}
