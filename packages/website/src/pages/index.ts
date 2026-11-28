import { languages, localizePath } from '$gemkit/i18n';

const GITHUB = 'https://github.com/mantou132/AgentDeck';

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', zh: '中文' };

const AGENTS = [
  'Claude Code',
  'Codex',
  'Cursor',
  'GitHub Copilot',
  'Google Antigravity',
  'OpenCode',
  'Qwen Code',
  'Kimi Code',
];

const FEATURE_ICONS = {
  notify: svg`
    <path
      d="M6.5 9.5a5.5 5.5 0 1 1 11 0c0 4.5 1.8 6.2 2.5 7H4c.7-.8 2.5-2.5 2.5-7Z"
      fill="currentColor"
      fill-opacity="0.14"
    />
    <path d="M9.8 19.5a2.4 2.4 0 0 0 4.4 0" />
    <path d="M12 2.5V4" />
  `,
  approve: svg`
    <path
      d="M12 3 5 6v5.2c0 4.5 3 8.4 7 9.8 4-1.4 7-5.3 7-9.8V6l-7-3Z"
      fill="currentColor"
      fill-opacity="0.14"
    />
    <path d="m9 12 2 2 4.2-4.2" />
  `,
  voice: svg`
    <rect x="9" y="3" width="6" height="10" rx="3" fill="currentColor" fill-opacity="0.14" />
    <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17v4m-3.5 0h7" />
  `,
  agents: svg`
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" fill="currentColor" fill-opacity="0.14" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <circle cx="17" cy="17" r="3.5" fill="currentColor" fill-opacity="0.14" />
  `,
  review: svg`
    <rect x="3" y="4" width="18" height="16" rx="2.5" fill="currentColor" fill-opacity="0.12" />
    <path d="M3 8.5h18M9 8.5V20" />
    <path d="M12.5 13h5M12.5 16.5h3.5" />
  `,
  live: svg`
    <rect x="6" y="2.5" width="12" height="19" rx="2.5" fill="currentColor" fill-opacity="0.12" />
    <path d="M10.5 18.5h3" />
    <path d="M10.5 8.8 15 11.5l-4.5 2.7V8.8Z" fill="currentColor" />
  `,
} as const;

const FEATURES = ['notify', 'approve', 'voice', 'agents', 'review', 'live'] as const;

const flowArrow = () => html`
  <span class="arrow" aria-hidden="true">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 6.5h12m-2.5-2.5L16 6.5 13.5 9" />
      <path d="M16 13.5H4m2.5-2.5L4 13.5 6.5 16" />
    </svg>
  </span>
`;

const style = css`
  :scope {
    display: block;
  }
  .wrap {
    width: min(1120px, 100% - 40px);
    margin-inline: auto;
  }

  /* Nav */
  nav {
    position: sticky;
    top: 0;
    z-index: 10;
    backdrop-filter: blur(14px);
    background: rgb(255 255 255 / 0.8);
    border-bottom: 1px solid var(--line);
  }
  nav .wrap {
    display: flex;
    align-items: center;
    gap: 24px;
    height: 60px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    text-decoration: none;
  }
  .brand img {
    width: 30px;
    height: 30px;
    border-radius: 8px;
  }
  nav .links {
    display: flex;
    gap: 22px;
    margin-left: auto;
    font-size: 14px;
  }
  nav .links a {
    color: var(--muted);
    text-decoration: none;
  }
  nav .links a:hover {
    color: var(--text);
  }

  /* Hero */
  .hero {
    position: relative;
    overflow: hidden;
    padding: 88px 0 72px;
  }
  .hero .wrap {
    position: relative;
    display: grid;
    grid-template-columns: 1.15fr 0.85fr;
    gap: 48px;
    align-items: center;
  }
  .eyebrow {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    padding: 4px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 13px;
    color: var(--muted);
  }
  .eyebrow b {
    color: var(--accent-strong);
    font-weight: 600;
  }
  h1 {
    margin: 20px 0 16px;
    font-size: clamp(40px, 6vw, 64px);
    line-height: 1.05;
    letter-spacing: -0.03em;
  }
  h1 span {
    color: var(--accent);
  }
  .lead {
    margin: 0 0 32px;
    max-width: 560px;
    font-size: 19px;
    color: var(--muted);
  }
  .apk {
    margin-top: 14px;
    font-size: 14px;
    color: var(--muted);
  }

  /* Phone mockup (mirrors real AgentDeck iOS session screen) */
  .phone {
    justify-self: center;
    width: 308px;
    padding: 11px;
    border-radius: 48px;
    background: #1c1d24;
    box-shadow:
      inset 0 0 0 1px rgb(255 255 255 / 0.14),
      0 40px 80px -30px rgb(21 22 28 / 0.35);
  }
  .screen {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 600px;
    overflow: hidden;
    border-radius: 38px;
    background: #f4f6fa;
    color: #383b50;
    font-size: 12px;
    line-height: 1.5;
  }
  .status-bar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 10px 18px 4px;
    background: rgb(244 246 250 / 0.88);
    color: #17192b;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .island {
    width: 82px;
    height: 22px;
    border-radius: 999px;
    background: #000;
  }
  .status-icons {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
  }
  .status-icons svg {
    display: block;
    height: 10px;
    width: auto;
  }
  .screen header {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) 32px;
    align-items: center;
    gap: 4px;
    padding: 2px 10px 7px;
    background: rgb(244 246 250 / 0.88);
    border-bottom: 0.5px solid #c9cddb;
  }
  .nav-ico {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: #17192b;
  }
  .nav-ico svg {
    width: 16px;
    height: 16px;
    display: block;
  }
  .nav-title {
    min-width: 0;
    text-align: center;
  }
  .nav-title b {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-rounded, "SF Pro Rounded", "Avenir Next", system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.25;
    color: #17192b;
  }
  .nav-title small {
    display: block;
    margin-top: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 10px;
    color: #767a91;
  }
  .msgs {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 12px 13px 6px;
  }
  .bubble.me {
    align-self: flex-end;
    max-width: 86%;
    padding: 8px 11px;
    border-radius: 15px 15px 4px 15px;
    background: #ececff;
    color: #17192b;
    font-size: 11.5px;
    line-height: 1.48;
  }
  .agent-reply {
    font-size: 11.5px;
    line-height: 1.56;
    color: #383b50;
  }
  .process {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 11px;
    color: #767a91;
  }
  .process span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .process .p-ico {
    flex: none;
    width: 13px;
    height: 13px;
    display: block;
  }
  .process.pending .p-ico {
    color: #4549cf;
    animation: activity 1.5s ease-in-out infinite;
  }
  .process .p-chev {
    flex: none;
    width: 11px;
    height: 11px;
    color: #a7aabc;
    display: block;
  }
  @keyframes activity {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  .dock {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 4px 8px 7px;
    background: rgb(244 246 250 / 0.9);
  }
  .perm {
    overflow: hidden;
    border: 1px solid rgb(217 139 54 / 0.72);
    border-radius: 13px;
    background: #fff;
    animation: rise 0.55s 0.55s both cubic-bezier(0.2, 0.9, 0.3, 1.15);
  }
  .perm-body {
    padding: 9px 11px 8px;
  }
  .perm b {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: #17192b;
  }
  .perm pre {
    margin: 6px 0 0;
    padding: 6px 8px;
    border-radius: 7px;
    background: #f4f6fa;
    font-family: var(--mono);
    font-size: 9.8px;
    line-height: 1.45;
    color: #383b50;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .perm-params {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 5px;
    font-size: 10px;
    color: #767a91;
  }
  .perm-params svg {
    width: 8px;
    height: 8px;
    display: block;
  }
  .perm .btns {
    display: flex;
    gap: 6px;
    padding: 7px 9px;
    border-top: 0.5px solid #e3e6ef;
  }
  .perm .btns span {
    flex: 1;
    padding: 6px 4px;
    border-radius: 9px;
    border: 0.5px solid #e3e6ef;
    background: #fff;
    color: #767a91;
    text-align: center;
    font-size: 10.5px;
    font-weight: 500;
    white-space: nowrap;
  }
  .perm .btns .always {
    border-color: #5a5fe8;
    color: #5a5fe8;
  }
  .perm .btns .allow {
    border-color: #5a5fe8;
    background: #5a5fe8;
    color: #fff;
  }
  .composer {
    border: 0.5px solid rgb(90 95 232 / 0.16);
    border-radius: 20px;
    background: #fff;
    box-shadow: 0 6px 18px rgb(45 48 82 / 0.06);
  }
  .composer-input {
    padding: 9px 12px 3px;
    font-size: 11.5px;
    color: #a7aabc;
  }
  .composer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 7px 6px;
  }
  .composer-left,
  .composer-right {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #767a91;
  }
  .composer-ico {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
  }
  .composer-ico svg {
    width: 14px;
    height: 14px;
    display: block;
  }
  .composer-model {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10.5px;
    font-weight: 500;
    color: #767a91;
  }
  .composer-model svg {
    width: 10px;
    height: 10px;
    display: block;
  }
  .composer-stop {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #5a5fe8;
    color: #fff;
  }
  .composer-stop i {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: currentColor;
  }
  .home-bar {
    width: 96px;
    height: 3.5px;
    margin: 1px auto 0;
    border-radius: 999px;
    background: rgb(23 25 43 / 0.2);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(14px);
    }
  }

  /* Agents strip */
  .agents {
    padding: 28px 0;
    border-block: 1px solid var(--line);
    background: var(--bg-2);
  }
  .agents .wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 28px;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-weight: 600;
  }
  .agents .wrap > span:first-child {
    font-weight: 400;
    font-size: 14px;
  }

  /* Sections */
  section {
    padding: 96px 0;
  }
  h2 {
    margin: 0 0 12px;
    font-size: clamp(30px, 4vw, 42px);
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .sub {
    margin: 0 0 48px;
    max-width: 620px;
    color: var(--muted);
    font-size: 18px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  .card {
    padding: 26px;
    border: 1px solid var(--line);
    border-radius: 20px;
  }
  .card .ico {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    margin-bottom: 16px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .card .ico svg {
    width: 22px;
    height: 22px;
    display: block;
  }
  .card h3 {
    margin: 0 0 6px;
    font-size: 18px;
  }
  .card p {
    margin: 0;
    color: var(--muted);
    font-size: 15px;
  }

  /* Steps */
  .steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    counter-reset: step;
  }
  .step {
    counter-increment: step;
  }
  .step::before {
    content: counter(step);
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin-bottom: 14px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
  }

  /* Architecture */
  .flow {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;
    margin-top: 8px;
    padding: 32px 24px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: var(--bg-2);
    font-weight: 600;
  }
  .flow .node {
    flex: 0 1 190px;
    padding: 12px 16px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--bg);
    text-align: center;
  }
  .flow .node small {
    display: block;
    font-weight: 400;
    font-size: 12px;
    color: var(--muted);
  }
  .flow .node.relay {
    border-style: dashed;
  }
  .flow .arrow {
    flex: none;
    display: grid;
    place-items: center;
    color: var(--accent);
  }
  .flow .arrow svg {
    width: 20px;
    height: 20px;
    display: block;
  }

  /* CTA */
  .cta {
    text-align: center;
    background: var(--bg-2);
  }
  .cta app-stores {
    justify-content: center;
  }
  .cta .sub {
    margin-inline: auto;
  }

  footer {
    padding: 32px 0;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 14px;
  }
  footer .wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    justify-content: space-between;
  }
  footer .links {
    display: flex;
    gap: 20px;
  }
  footer .links a {
    text-decoration: none;
  }
  footer .links a:hover {
    color: var(--text);
  }

  @media (max-width: 860px) {
    .hero {
      padding-top: 56px;
    }
    .hero .wrap,
    .grid,
    .steps {
      grid-template-columns: minmax(0, 1fr);
    }
    .flow {
      flex-direction: column;
      gap: 10px;
      padding: 24px 20px;
    }
    .flow .node {
      flex: none;
      width: 100%;
      max-width: 260px;
    }
    .flow .arrow svg {
      transform: rotate(90deg);
    }
    nav .links a:not(.keep) {
      display: none;
    }
    section {
      padding: 72px 0;
    }
  }
`;

const link = (href: string) => (text: string) => html`<a href=${href}>${text}</a>`;

@page({
  title: () => i18n.get('title'),
  meta: () => ({
    description: i18n.get('description'),
    'og:title': i18n.get('title'),
    'og:description': i18n.get('ogDescription'),
  }),
})
@adoptedStyle(style)
export default class HomePage extends GemElement {
  @template()
  #content = () => html`
    <nav>
      <div class="wrap">
        <a class="brand" href=${localizePath(i18n.currentLanguage)}><img src="/icon.png" alt="" />AgentDeck</a>
        <div class="links">
          <a href="#features">${i18n.get('navFeatures')}</a>
          <a href="#start">${i18n.get('navStart')}</a>
          <a href="#security">${i18n.get('navSecurity')}</a>
          <a class="keep" href=${GITHUB}>GitHub</a>
          ${languages
            .filter((lang) => lang !== i18n.currentLanguage)
            .map((lang) => html`<a class="keep" href=${localizePath(lang)}>${LANGUAGE_NAMES[lang]}</a>`)}
        </div>
      </div>
    </nav>

    <header class="hero">
      <div class="wrap">
        <div>
          <span class="eyebrow">${i18n.get('eyebrow', (s) => html`<b>${s}</b>`)}</span>
          <h1>
            ${i18n.get(
              'heroTitle',
              () => html`<br />`,
              (s) => html`<span>${s}</span>`,
            )}
          </h1>
          <p class="lead">${i18n.get('heroLead')}</p>
          <app-stores></app-stores>
          <p class="apk">
            ${i18n.get('apk', link(`${GITHUB}/releases/latest`), link('https://testflight.apple.com/join/RWqpYgwm'))}
          </p>
        </div>

        <div class="phone" aria-hidden="true">
          <div class="screen">
            <div class="status-bar">
              <span>9:41</span>
              <div class="island"></div>
              <div class="status-icons">
                <svg viewBox="0 0 15 10" fill="currentColor">
                  <rect x="0" y="6.5" width="2.4" height="3.5" rx="0.8" />
                  <rect x="3.8" y="4.5" width="2.4" height="5.5" rx="0.8" />
                  <rect x="7.6" y="2.2" width="2.4" height="7.8" rx="0.8" />
                  <rect x="11.4" y="0" width="2.4" height="10" rx="0.8" />
                </svg>
                <svg viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                  <path d="M1.5 3.6a8.2 8.2 0 0 1 11 0M4 6.2a4.6 4.6 0 0 1 6 0" />
                  <circle cx="7" cy="8.7" r="1" fill="currentColor" stroke="none" />
                </svg>
                <svg viewBox="0 0 22 10" fill="none">
                  <rect x="0.7" y="0.7" width="18" height="8.6" rx="2.3" stroke="currentColor" stroke-width="1.2" opacity="0.45" />
                  <rect x="2.2" y="2.2" width="13.5" height="5.6" rx="1.2" fill="currentColor" />
                  <path d="M20.3 3.4v3.2a1.3 1.3 0 0 0 0-3.2Z" fill="currentColor" opacity="0.5" />
                </svg>
              </div>
            </div>
            <header>
              <span class="nav-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 5L5 12L12 19M5 12H19" />
                </svg>
              </span>
              <div class="nav-title">
                <b>${i18n.get('mockTitle')}</b>
                <small>~/work/web-app</small>
              </div>
              <span class="nav-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12H19M12 5V19" />
                </svg>
              </span>
            </header>
            <div class="msgs">
              <div class="bubble me">${i18n.get('mockMe')}</div>
              <div class="process">
                <svg class="p-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19H20M4 17L10 11L4 5" />
                </svg>
                <span>${i18n.get('mockTools')}</span>
                <svg class="p-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 18L15 12L9 6" />
                </svg>
              </div>
              <div class="agent-reply">${i18n.get('mockAgent')}</div>
              <div class="process pending">
                <svg class="p-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 12h-3l-2.5 8-5-16L9 12H2" />
                </svg>
                <span>pnpm test:e2e login --repeat-each=20</span>
                <svg class="p-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 18L15 12L9 6" />
                </svg>
              </div>
            </div>
            <div class="dock">
              <div class="perm">
                <div class="perm-body">
                  <b>${i18n.get('mockPermTitle')}</b>
                  <pre>pnpm test:e2e login --repeat-each=20</pre>
                  <div class="perm-params">
                    <svg viewBox="0 0 10 10" fill="currentColor"><path d="M3 2l4.5 3L3 8Z" /></svg>
                    <span>${i18n.get('mockPermParams')}</span>
                  </div>
                </div>
                <div class="btns">
                  <span>${i18n.get('mockDeny')}</span>
                  <span class="always">${i18n.get('mockAllowAlways')}</span>
                  <span class="allow">${i18n.get('mockAllow')}</span>
                </div>
              </div>
              <div class="composer">
                <div class="composer-input">${i18n.get('mockPlaceholder')}</div>
                <div class="composer-bar">
                  <div class="composer-left">
                    <span class="composer-ico">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M16 6l-8.4 8.6a2 2 0 0 0 2.8 2.8l8.4-8.6a4 4 0 0 0-5.6-5.6L4.8 11.7a6 6 0 0 0 8.5 8.5l8.4-8.5" />
                      </svg>
                    </span>
                    <span class="composer-model">
                      Claude Opus
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 9L12 15L18 9" />
                      </svg>
                    </span>
                  </div>
                  <div class="composer-right">
                    <span class="composer-ico">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="2" width="6" height="12" rx="3" />
                        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
                      </svg>
                    </span>
                    <span class="composer-stop"><i></i></span>
                  </div>
                </div>
              </div>
              <div class="home-bar"></div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <div class="agents">
      <div class="wrap">
        <span>${i18n.get('worksWith')}</span>
        ${AGENTS.map((name) => html`<span>${name}</span>`)}
        <span>${i18n.get('anyAgent')}</span>
      </div>
    </div>

    <section id="features">
      <div class="wrap">
        <h2>${i18n.get('featuresTitle')}</h2>
        <p class="sub">${i18n.get('featuresSub')}</p>
        <div class="grid">
          ${FEATURES.map(
            (key) => html`
              <div class="card">
                <div class="ico" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    ${FEATURE_ICONS[key]}
                  </svg>
                </div>
                <h3>${i18n.get(`${key}Title`)}</h3>
                <p>${i18n.get(`${key}Desc`)}</p>
              </div>
            `,
          )}
        </div>
      </div>
    </section>

    <section id="demo">
      <div class="wrap">
        <h2>${i18n.get('demoTitle')}</h2>
        <p class="sub">${i18n.get('demoSub')}</p>
        <app-video video-id="XVVrMgwf2YA"></app-video>
      </div>
    </section>

    <section id="start">
      <div class="wrap">
        <h2>${i18n.get('startTitle')}</h2>
        <p class="sub">${i18n.get('startSub')}</p>
        <div class="steps">
          <div class="card step">
            <h3>${i18n.get('installTitle')}</h3>
            <p>${i18n.get('installDesc')}</p>
            <app-cmd command="npm install -g agentdeckd"></app-cmd>
            <app-cmd command="brew install mantou132/tap/agentdeckd"></app-cmd>
          </div>
          <div class="card step">
            <h3>${i18n.get('runTitle')}</h3>
            <p>${i18n.get('runDesc')}</p>
            <app-cmd command="agentdeckd start"></app-cmd>
          </div>
          <div class="card step">
            <h3>${i18n.get('scanTitle')}</h3>
            <p>${i18n.get('scanDesc', (s) => html`<b>${s}</b>`)}</p>
          </div>
        </div>
      </div>
    </section>

    <section id="security">
      <div class="wrap">
        <h2>${i18n.get('securityTitle')}</h2>
        <p class="sub">${i18n.get('securitySub', link('https://github.com/mantou132/relay'))}</p>
        <div class="flow">
          <div class="node">${i18n.get('flowApp')}<small>${i18n.get('flowPhone')}</small></div>
          ${flowArrow()}
          <div class="node relay">Relay<small>${i18n.get('flowRelay')}</small></div>
          ${flowArrow()}
          <div class="node">agentdeckd<small>${i18n.get('flowComputer')}</small></div>
          ${flowArrow()}
          <div class="node">${i18n.get('flowAgents')}<small>Claude Code, Codex…</small></div>
        </div>
      </div>
    </section>

    <section class="cta">
      <div class="wrap">
        <h2>${i18n.get('ctaTitle')}</h2>
        <p class="sub">${i18n.get('ctaSub')}</p>
        <app-stores></app-stores>
      </div>
    </section>

    <footer>
      <div class="wrap">
        <span>© AgentDeck</span>
        <div class="links">
          <a href=${GITHUB}>GitHub</a>
          <a href="${GITHUB}/issues">${i18n.get('support')}</a>
          <a href="${GITHUB}/blob/main/PRIVACY_POLICY.md">${i18n.get('privacy')}</a>
        </div>
      </div>
    </footer>
  `;
}
