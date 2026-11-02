import { languages, localizePath } from '$gemkit/i18n';

const GITHUB = 'https://github.com/mantou132/AgentDeck';

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', zh: '中文' };

const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Antigravity', 'OpenCode', 'Qwen Code', 'Kimi CLI'];

const FEATURES = [
  { icon: '🔔', key: 'notify' },
  { icon: '✅', key: 'approve' },
  { icon: '🎙️', key: 'voice' },
  { icon: '🧩', key: 'agents' },
  { icon: '🔍', key: 'review' },
  { icon: '📱', key: 'live' },
] as const;

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
    background: rgb(14 17 51 / 0.7);
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
  .hero::before {
    content: "";
    position: absolute;
    inset: -30% -10% auto;
    height: 120%;
    background:
      radial-gradient(40% 40% at 70% 30%, rgb(85 104 239 / 0.35), transparent 70%),
      radial-gradient(30% 30% at 85% 60%, rgb(98 211 223 / 0.2), transparent 70%);
    pointer-events: none;
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
    background: var(--card);
  }
  .eyebrow b {
    color: var(--cyan);
    font-weight: 600;
  }
  h1 {
    margin: 20px 0 16px;
    font-size: clamp(40px, 6vw, 64px);
    line-height: 1.05;
    letter-spacing: -0.03em;
  }
  h1 span {
    background: linear-gradient(90deg, var(--indigo), var(--cyan));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
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

  /* Phone mockup */
  .phone {
    justify-self: center;
    width: 300px;
    padding: 12px;
    border-radius: 46px;
    background: linear-gradient(160deg, #2a2f63, #11143a);
    box-shadow:
      0 0 0 1px var(--line),
      0 40px 80px -20px rgb(0 0 0 / 0.6),
      0 0 120px -20px rgb(85 104 239 / 0.5);
  }
  .screen {
    position: relative;
    height: 580px;
    overflow: hidden;
    border-radius: 36px;
    background: #f3f4fa;
    color: #1b1e3d;
    font-size: 13px;
  }
  .screen header {
    padding: 46px 18px 12px;
    background: #fff;
    border-bottom: 1px solid #e6e8f2;
  }
  .screen header b {
    display: block;
    font-size: 15px;
  }
  .screen header small {
    color: #7a7f9f;
  }
  .island {
    position: absolute;
    top: 12px;
    left: 50%;
    width: 92px;
    height: 26px;
    border-radius: 20px;
    background: #000;
    transform: translateX(-50%);
  }
  .msgs {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }
  .bubble {
    max-width: 85%;
    padding: 9px 12px;
    border-radius: 16px;
    line-height: 1.45;
  }
  .bubble.me {
    align-self: flex-end;
    background: var(--indigo);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .bubble.agent {
    background: #fff;
    border-bottom-left-radius: 4px;
  }
  .tool {
    font-family: var(--mono);
    font-size: 11px;
    color: #5b6085;
    padding: 6px 10px;
    background: #e9ebf6;
    border-radius: 8px;
  }
  .perm {
    position: absolute;
    right: 12px;
    bottom: 14px;
    left: 12px;
    padding: 14px;
    border-radius: 18px;
    background: #fff;
    box-shadow: 0 10px 30px rgb(27 30 61 / 0.18);
    animation: rise 0.6s 0.8s both cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  .perm b {
    display: block;
    margin-bottom: 4px;
  }
  .perm code {
    display: block;
    margin: 6px 0 12px;
    padding: 6px 8px;
    border-radius: 8px;
    background: #f3f4fa;
    font-size: 11px;
  }
  .perm .btns {
    display: flex;
    gap: 8px;
  }
  .perm .btns span {
    flex: 1;
    padding: 8px;
    border-radius: 10px;
    text-align: center;
    font-weight: 600;
    background: #eceef7;
  }
  .perm .btns span:first-child {
    background: var(--indigo);
    color: #fff;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(30px);
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
    background: var(--card);
  }
  .card .ico {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    margin-bottom: 16px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgb(85 104 239 / 0.3), rgb(98 211 223 / 0.2));
    font-size: 20px;
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
    background: var(--indigo);
    font-weight: 700;
  }

  /* Architecture */
  .flow {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: center;
    margin-top: 8px;
    padding: 32px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: var(--card);
    font-weight: 600;
  }
  .flow .node {
    padding: 12px 18px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--bg-2);
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
    color: var(--cyan);
  }

  /* CTA */
  .cta {
    text-align: center;
    background: radial-gradient(50% 80% at 50% 100%, rgb(85 104 239 / 0.3), transparent 70%), var(--bg);
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
          <p class="apk">${i18n.get('apk', link(`${GITHUB}/releases/latest`))}</p>
        </div>

        <div class="phone" aria-hidden="true">
          <div class="screen">
            <div class="island"></div>
            <header>
              <b>${i18n.get('mockTitle')}</b>
              <small>Claude Code · ~/work/web-app</small>
            </header>
            <div class="msgs">
              <div class="bubble me">${i18n.get('mockMe')}</div>
              <div class="tool">✓ Read e2e/login.spec.ts</div>
              <div class="tool">✓ Grep "waitForTimeout"</div>
              <div class="bubble agent">${i18n.get('mockAgent')}</div>
              <div class="tool">✓ Edit e2e/login.spec.ts (+3 −2)</div>
            </div>
            <div class="perm">
              <b>${i18n.get('mockPermTitle')}</b>
              <span>${i18n.get('mockPermDesc')}</span>
              <code>pnpm test:e2e login --repeat-each=20</code>
              <div class="btns"><span>${i18n.get('mockAllow')}</span><span>${i18n.get('mockDeny')}</span></div>
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
            ({ icon, key }) => html`
              <div class="card">
                <div class="ico">${icon}</div>
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
          <span class="arrow">⇄</span>
          <div class="node relay">Relay<small>${i18n.get('flowRelay')}</small></div>
          <span class="arrow">⇄</span>
          <div class="node">agentdeckd<small>${i18n.get('flowComputer')}</small></div>
          <span class="arrow">⇄</span>
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
