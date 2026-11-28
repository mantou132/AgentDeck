/**
 * Studio-grade HTML/CSS marketing screenshot & Feature Graphic templates.
 * Produces platform-native compositions for:
 *   - App Store (iPhone 6.9": 1320 x 2868)
 *   - Google Play (Phone 9:16: 1080 x 1920)
 *   - Google Play Feature Graphic (1024 x 500)
 */

const SLIDES = {
  'en-US': [
    {
      id: '01-hero',
      raw: '01-chat',
      theme: 'hero',
      eyebrow: 'AGENTDECK',
      headline: 'Your agents,<br/><span>in your pocket.</span>',
      sub: 'Start, steer & approve local ACP agents from your phone.',
      badges: ['Claude Code', 'Codex', 'Cursor', 'Free Built-in'],
      phoneTilt: 'none',
    },
    {
      id: '02-approve',
      raw: '02-approve',
      theme: 'approve',
      eyebrow: 'AWAY FROM KEYBOARD',
      headline: 'Steer & approve<br/><span>from anywhere.</span>',
      sub: 'Approve commands remotely and get notified when tasks finish.',
      notification: {
        app: 'AgentDeck',
        time: 'now',
        title: 'Approval required · MacBook-Pro',
        body: 'pnpm run deploy:prod -- --canary 10%',
      },
      phoneTilt: 'none',
    },
    {
      id: '03-agents',
      raw: '03-sessions',
      theme: 'agents',
      eyebrow: 'ONE APP · EVERY AGENT',
      headline: 'Every project.<br/><span>Every agent.</span>',
      sub: 'Grouped by repo with live status and instant agent switching.',
      pills: ['Claude Code', 'Codex', 'Cursor', 'Copilot', 'Antigravity', 'OpenCode'],
      phoneTilt: 'none',
    },
    {
      id: '04-diff',
      raw: '04-diff',
      theme: 'diff',
      eyebrow: 'REVIEW REAL WORK',
      headline: 'Inspect code,<br/><span>not just chat.</span>',
      sub: 'Browse files, Git changes, code diffs and commit history.',
      diffChip: { branch: 'fix/oauth-single-flight', add: '+91', del: '-12', files: '4 files' },
      phoneTilt: 'none',
    },
    {
      id: '05-charts',
      raw: '05-chart',
      theme: 'charts',
      eyebrow: 'RICH OUTPUT',
      headline: 'Charts, maps &<br/><span>live previews.</span>',
      sub: (platform) =>
        platform === 'appstore'
          ? 'Interactive charts, HTML previews, iOS Simulator & browser views.'
          : 'Interactive charts, HTML previews, Android emulator & browser views.',
      pills: (platform) =>
        platform === 'appstore'
          ? ['ECharts', 'Maps', 'HTML Preview', 'Live Simulator']
          : ['ECharts', 'Maps', 'HTML Preview', 'Live Emulator'],
      phoneTilt: 'none',
    },
    {
      id: '06-tasks',
      raw: '06-tasks',
      theme: 'tasks',
      eyebrow: 'AUTOMATED & PRIVATE',
      headline: 'Runs on schedule.<br/><span>E2E encrypted.</span>',
      sub: 'Automate daily checks while code stays encrypted on your machine.',
      trust: ['End-to-End Encrypted', 'Open Source', 'Self-Hostable'],
      phoneTilt: 'none',
    },
  ],
  'zh-CN': [
    {
      id: '01-hero',
      raw: '01-chat',
      theme: 'hero',
      eyebrow: 'AGENTDECK',
      headline: '你的 Agent，<br/><span>装进口袋。</span>',
      sub: '在手机上启动、引导与审批本地 ACP Agent。',
      badges: ['Claude Code', 'Codex', 'Cursor', '内置免费 Agent'],
      phoneTilt: 'none',
    },
    {
      id: '02-approve',
      raw: '02-approve',
      theme: 'approve',
      eyebrow: '离开键盘也能掌控',
      headline: '随时审批权限，<br/><span>任务完成即推送。</span>',
      sub: '离开工位也能及时回应 Agent 提问与危险命令确认。',
      notification: {
        app: 'AgentDeck',
        time: '刚刚',
        title: '等待权限审批 · MacBook-Pro',
        body: 'pnpm run deploy:prod -- --canary 10%',
      },
      phoneTilt: 'none',
    },
    {
      id: '03-agents',
      raw: '03-sessions',
      theme: 'agents',
      eyebrow: '一个 APP · 管理所有 AGENT',
      headline: '所有项目与 Agent，<br/><span>尽在掌控。</span>',
      sub: '按仓库自动分组会话，实时同步运行中、待审批与未读状态。',
      pills: ['Claude Code', 'Codex', 'Cursor', 'Copilot', 'Antigravity', 'OpenCode'],
      phoneTilt: 'none',
    },
    {
      id: '04-diff',
      raw: '04-diff',
      theme: 'diff',
      eyebrow: '审阅真实成果',
      headline: '看清每一行 Diff，<br/><span>而不只是聊天。</span>',
      sub: '手机端直接浏览文件、Git 变更、代码高亮差异与提交记录。',
      diffChip: { branch: 'fix/oauth-single-flight', add: '+91', del: '-12', files: '4 个文件' },
      phoneTilt: 'none',
    },
    {
      id: '05-charts',
      raw: '05-chart',
      theme: 'charts',
      eyebrow: '富交互与实时画面',
      headline: '图表、地图与页面，<br/><span>对话内直接预览。</span>',
      sub: (platform) =>
        platform === 'appstore'
          ? '内置交互式图表、HTML 预览，还能实时观看 iOS 模拟器与浏览器。'
          : '内置交互式图表、HTML 预览，还能实时观看 Android 模拟器与浏览器。',
      pills: (platform) =>
        platform === 'appstore'
          ? ['交互图表', '地图', 'HTML 预览', '实时模拟器']
          : ['交互图表', '地图', 'HTML 预览', '实时模拟器'],
      phoneTilt: 'none',
    },
    {
      id: '06-tasks',
      raw: '06-tasks',
      theme: 'tasks',
      eyebrow: '定时运行 · 隐私优先',
      headline: '定时自动巡检，<br/><span>全程端到端加密。</span>',
      sub: '代码始终留在你自己的电脑，中继仅转发密文，支持自建中继。',
      trust: ['端到端加密', 'MIT 开源', '可自建中继'],
      phoneTilt: 'none',
    },
  ],
};

const THEME_AURAS = {
  hero: {
    bg: 'radial-gradient(120% 70% at 50% 0%, #1c1f42 0%, #0b0c14 55%, #07080d 100%)',
    glow1: 'radial-gradient(circle, rgba(98, 107, 240, 0.52) 0%, rgba(98, 107, 240, 0) 68%)',
    glow2: 'radial-gradient(circle, rgba(139, 92, 246, 0.34) 0%, rgba(139, 92, 246, 0) 70%)',
    accent: '#9ea8ff',
    accentGrad: 'linear-gradient(135deg, #c2c9ff 0%, #7d86ff 55%, #6366f1 100%)',
  },
  approve: {
    bg: 'radial-gradient(120% 70% at 50% 0%, #241b16 0%, #0d0c13 55%, #08080d 100%)',
    glow1: 'radial-gradient(circle, rgba(227, 146, 62, 0.40) 0%, rgba(227, 146, 62, 0) 68%)',
    glow2: 'radial-gradient(circle, rgba(98, 107, 240, 0.32) 0%, rgba(98, 107, 240, 0) 70%)',
    accent: '#f2b772',
    accentGrad: 'linear-gradient(135deg, #ffe0b5 0%, #f0aa5a 55%, #d98b36 100%)',
  },
  agents: {
    bg: 'radial-gradient(120% 70% at 50% 0%, #112233 0%, #0a0c14 55%, #07080d 100%)',
    glow1: 'radial-gradient(circle, rgba(79, 156, 249, 0.42) 0%, rgba(79, 156, 249, 0) 68%)',
    glow2: 'radial-gradient(circle, rgba(91, 201, 194, 0.28) 0%, rgba(91, 201, 194, 0) 70%)',
    accent: '#8dd8ff',
    accentGrad: 'linear-gradient(135deg, #d0f0ff 0%, #79c5ff 52%, #6379f6 100%)',
  },
  diff: {
    bg: 'radial-gradient(120% 70% at 50% 0%, #0f241f 0%, #0a0d13 55%, #07090d 100%)',
    glow1: 'radial-gradient(circle, rgba(52, 199, 140, 0.36) 0%, rgba(52, 199, 140, 0) 68%)',
    glow2: 'radial-gradient(circle, rgba(98, 107, 240, 0.30) 0%, rgba(98, 107, 240, 0) 70%)',
    accent: '#7ce2b8',
    accentGrad: 'linear-gradient(135deg, #c6f7e2 0%, #5fd4a3 55%, #34b582 100%)',
  },
  charts: {
    bg: 'radial-gradient(120% 70% at 50% 0%, #1c1836 0%, #0b0c14 55%, #07080d 100%)',
    glow1: 'radial-gradient(circle, rgba(130, 110, 255, 0.46) 0%, rgba(130, 110, 255, 0) 68%)',
    glow2: 'radial-gradient(circle, rgba(56, 189, 248, 0.30) 0%, rgba(56, 189, 248, 0) 70%)',
    accent: '#b4b8ff',
    accentGrad: 'linear-gradient(135deg, #dcdfff 0%, #989fff 50%, #56b9f5 100%)',
  },
  tasks: {
    bg: 'radial-gradient(120% 70% at 50% 0%, #131c30 0%, #0a0c13 55%, #07080d 100%)',
    glow1: 'radial-gradient(circle, rgba(94, 114, 235, 0.44) 0%, rgba(94, 114, 235, 0) 68%)',
    glow2: 'radial-gradient(circle, rgba(47, 155, 112, 0.32) 0%, rgba(47, 155, 112, 0) 70%)',
    accent: '#9bb4ff',
    accentGrad: 'linear-gradient(135deg, #c9f2e1 0%, #86a3ff 55%, #646cff 100%)',
  },
};

const statusBarSvg = (isIos) => `
  <div class="status-bar ${isIos ? 'ios' : 'android'}">
    <span class="time">9:41</span>
    ${isIos ? '<div class="island"></div>' : '<div class="punch-hole"></div>'}
    <div class="sys-icons">
      <svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="4.5" y="5" width="3" height="7" rx="1"/><rect x="9" y="2.5" width="3" height="9.5" rx="1"/><rect x="13.5" y="0" width="3" height="12" rx="1"/></svg>
      <svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.5 4.2a9.5 9.5 0 0 1 13 0"/><path d="M4.2 7a5.8 5.8 0 0 1 7.6 0"/><circle cx="8" cy="10.2" r="1.1" fill="currentColor" stroke="none"/></svg>
      <svg viewBox="0 0 25 12" fill="none"><rect x="0.7" y="1" width="20.6" height="10" rx="2.8" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.3"/><rect x="2.5" y="2.8" width="16.5" height="6.4" rx="1.4" fill="currentColor"/><path d="M23 4.2v3.6a1.4 1.4 0 0 0 0-3.6Z" fill="currentColor" fill-opacity="0.5"/></svg>
    </div>
  </div>
`;

export function getSlides(lang) {
  return SLIDES[lang];
}

export function renderSlideHtml({
  slide,
  platform,
  lang,
  screenDataUrl,
  iconDataUrl,
  width: targetWidth,
  height: targetHeight,
}) {
  const isAppStore = platform === 'appstore';
  const isZh = lang === 'zh-CN';
  const baseWidth = isAppStore ? 1320 : 1080;
  const baseHeight = isAppStore ? 2868 : 1920;
  const width = targetWidth ?? baseWidth;
  const height = targetHeight ?? baseHeight;
  const scale = width / baseWidth;
  const canvasHeight = Math.ceil(height / scale);
  const aura = THEME_AURAS[slide.theme];

  const sub = typeof slide.sub === 'function' ? slide.sub(platform) : slide.sub;
  const pills = typeof slide.pills === 'function' ? slide.pills(platform) : slide.pills;

  // Carefully tuned proportions so both App Store (1320x2868 / 1206x2622) and Google Play (1080x1920) show the full phone UI cleanly.
  // Raw screenshots are captured at 412x892 with real --safe-area-inset-top: 54px and --safe-area-inset-bottom: 24px.
  const padTop = isAppStore ? 128 : 54;
  const padX = isAppStore ? 94 : 64;
  const h1Size = isAppStore ? (isZh ? 102 : 108) : isZh ? 62 : 66;
  const subSize = isAppStore ? 40 : 25;
  const phoneWidth = isAppStore ? 996 : 668;
  const phoneRadius = isAppStore ? 124 : 70;
  const bezelPad = isAppStore ? 24 : 15;
  const innerRadius = phoneRadius - bezelPad;
  const screenWidth = phoneWidth - bezelPad * 2;
  const safeTopPx = Math.round((screenWidth * 54) / 412);
  const phoneTopGap = isAppStore ? (slide.notification ? 48 : 66) : slide.notification ? 20 : 26;

  const extraStrip = (() => {
    if (slide.badges) {
      return `<div class="chip-row">${slide.badges
        .map((b, i) => `<span class="chip ${i === 3 ? 'chip-accent' : ''}">${b}</span>`)
        .join('')}</div>`;
    }
    if (pills) {
      return `<div class="chip-row">${pills.map((p) => `<span class="chip">${p}</span>`).join('')}</div>`;
    }
    if (slide.trust) {
      return `<div class="chip-row">${slide.trust
        .map(
          (t) =>
            `<span class="chip chip-trust"><svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 5"/></svg>${t}</span>`,
        )
        .join('')}</div>`;
    }
    if (slide.diffChip) {
      return `<div class="chip-row">
        <span class="chip chip-mono"><span class="dot-branch"></span>${slide.diffChip.branch}</span>
        <span class="chip chip-mono"><span class="c-add">${slide.diffChip.add}</span> <span class="c-del">${slide.diffChip.del}</span> · ${slide.diffChip.files}</span>
      </div>`;
    }
    if (slide.notification) {
      return `<div class="push-banner">
        <img class="push-icon" src="${iconDataUrl}" alt="" />
        <div class="push-body">
          <div class="push-top">
            <span class="push-title">${slide.notification.title}</span>
            <span class="push-time">${slide.notification.time}</span>
          </div>
          <div class="push-cmd">${slide.notification.body}</div>
        </div>
      </div>`;
    }
    return '';
  })();

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: #08090f;
    font-family: ${isZh ? '"PingFang SC", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif' : '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Inter, sans-serif'};
    -webkit-font-smoothing: antialiased;
    color: #ffffff;
  }
  .canvas {
    position: relative;
    width: ${baseWidth}px;
    height: ${canvasHeight}px;
    zoom: ${scale};
    background: ${aura.bg};
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: ${padTop}px ${padX}px 0;
    overflow: hidden;
  }
  /* Subtle architectural dot grid */
  .grid-bg {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(rgba(255, 255, 255, 0.09) 1.5px, transparent 1.5px);
    background-size: ${isAppStore ? 44 : 34}px ${isAppStore ? 44 : 34}px;
    mask-image: linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.12) 55%, rgba(0,0,0,0) 90%);
    pointer-events: none;
  }
  .glow-1 {
    position: absolute;
    width: ${isAppStore ? 1320 : 1040}px;
    height: ${isAppStore ? 1320 : 1040}px;
    top: ${isAppStore ? 340 : 180}px;
    left: 50%;
    transform: translateX(-50%);
    background: ${aura.glow1};
    filter: blur(${isAppStore ? 50 : 38}px);
    pointer-events: none;
  }
  .glow-2 {
    position: absolute;
    width: ${isAppStore ? 980 : 760}px;
    height: ${isAppStore ? 980 : 760}px;
    bottom: ${isAppStore ? -120 : -140}px;
    right: ${isAppStore ? -180 : -140}px;
    background: ${aura.glow2};
    filter: blur(${isAppStore ? 60 : 44}px);
    pointer-events: none;
  }
  .header {
    position: relative;
    z-index: 2;
    width: 100%;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: ${isAppStore ? 14 : 10}px;
    padding: ${isAppStore ? '11px 24px' : '8px 18px'};
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.13);
    backdrop-filter: blur(16px);
    font-size: ${isAppStore ? 24 : 17}px;
    font-weight: 700;
    letter-spacing: ${isZh ? '0.08em' : '0.14em'};
    color: ${aura.accent};
    margin-bottom: ${isAppStore ? 36 : 22}px;
  }
  .eyebrow-icon {
    width: ${isAppStore ? 34 : 24}px;
    height: ${isAppStore ? 34 : 24}px;
    border-radius: ${isAppStore ? 9 : 6}px;
    display: block;
  }
  .eyebrow-dot {
    width: ${isAppStore ? 12 : 9}px;
    height: ${isAppStore ? 12 : 9}px;
    border-radius: 999px;
    background: ${aura.accent};
    box-shadow: 0 0 14px ${aura.accent};
  }
  h1 {
    font-size: ${h1Size}px;
    font-weight: ${isZh ? 700 : 800};
    line-height: ${isZh ? 1.16 : 1.05};
    letter-spacing: ${isZh ? '-0.02em' : '-0.036em'};
    color: #ffffff;
    text-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  }
  h1 span {
    background: ${aura.accentGrad};
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .sub {
    margin-top: ${isAppStore ? 26 : 14}px;
    max-width: ${isAppStore ? 1060 : 900}px;
    font-size: ${subSize}px;
    font-weight: 450;
    line-height: 1.4;
    color: rgba(226, 230, 245, 0.74);
    letter-spacing: ${isZh ? '0.01em' : '-0.01em'};
    text-wrap: balance;
  }
  .chip-row {
    margin-top: ${isAppStore ? 34 : 18}px;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: ${isAppStore ? 16 : 10}px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: ${isAppStore ? 10 : 7}px;
    padding: ${isAppStore ? '13px 26px' : '8px 16px'};
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.065);
    border: 1px solid rgba(255, 255, 255, 0.13);
    color: rgba(244, 246, 255, 0.92);
    font-size: ${isAppStore ? 26 : 18}px;
    font-weight: 600;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  }
  .chip-accent {
    background: rgba(98, 107, 240, 0.24);
    border-color: rgba(154, 165, 255, 0.42);
    color: #d6dbff;
  }
  .chip-mono {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: ${isAppStore ? 24 : 17}px;
  }
  .dot-branch {
    width: ${isAppStore ? 12 : 9}px;
    height: ${isAppStore ? 12 : 9}px;
    border-radius: 999px;
    background: #5fd4a3;
  }
  .c-add { color: #6ee7b7; font-weight: 700; }
  .c-del { color: #f87171; font-weight: 700; }
  .chip-trust .check {
    width: ${isAppStore ? 24 : 18}px;
    height: ${isAppStore ? 24 : 18}px;
    color: #6ee7b7;
  }

  /* Glassmorphic floating push notification for slide 2 */
  .push-banner {
    margin-top: ${isAppStore ? 34 : 16}px;
    width: ${isAppStore ? 980 : 716}px;
    display: flex;
    align-items: center;
    gap: ${isAppStore ? 24 : 16}px;
    padding: ${isAppStore ? '22px 28px' : '14px 20px'};
    border-radius: ${isAppStore ? 38 : 24}px;
    background: linear-gradient(180deg, rgba(44, 46, 62, 0.88) 0%, rgba(28, 30, 42, 0.92) 100%);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.48),
      inset 0 1px 0 rgba(255, 255, 255, 0.18);
    text-align: left;
  }
  .push-icon {
    width: ${isAppStore ? 74 : 50}px;
    height: ${isAppStore ? 74 : 50}px;
    border-radius: ${isAppStore ? 17 : 12}px;
    flex-shrink: 0;
  }
  .push-body { min-width: 0; flex: 1; }
  .push-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .push-title {
    font-size: ${isAppStore ? 28 : 19}px;
    font-weight: 700;
    color: #ffffff;
  }
  .push-time {
    font-size: ${isAppStore ? 23 : 15}px;
    color: rgba(255, 255, 255, 0.5);
  }
  .push-cmd {
    margin-top: ${isAppStore ? 6 : 3}px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: ${isAppStore ? 24 : 16}px;
    color: #f3c184;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Device stage */
  .stage {
    position: relative;
    z-index: 2;
    margin-top: ${phoneTopGap}px;
    flex: 1;
    width: 100%;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }
  .phone-shell {
    position: relative;
    width: ${phoneWidth}px;
    padding: ${bezelPad}px;
    border-radius: ${phoneRadius}px;
    background: linear-gradient(155deg, #4a4e5e 0%, #1c1e27 18%, #101118 52%, #2c2f3c 84%, #14161e 100%);
    box-shadow:
      0 60px 140px rgba(0, 0, 0, 0.72),
      0 18px 46px rgba(0, 0, 0, 0.55),
      0 0 0 2px rgba(255, 255, 255, 0.14),
      inset 0 2px 3px rgba(255, 255, 255, 0.22);
  }
  .phone-screen {
    position: relative;
    width: 100%;
    border-radius: ${innerRadius}px;
    overflow: hidden;
    background: #18191b;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  }
  .status-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: ${safeTopPx}px;
    z-index: 5;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    background: transparent;
    color: rgba(245, 247, 252, 0.96);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .status-bar.ios {
    padding: 4px 52px 0;
    font-size: 32px;
  }
  .status-bar.android {
    padding: 0 34px;
    font-size: 21px;
  }
  .island {
    width: 244px;
    height: 66px;
    border-radius: 999px;
    background: #000000;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  }
  .punch-hole {
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: #000000;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.07);
  }
  .sys-icons {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${isAppStore ? 16 : 10}px;
  }
  .sys-icons svg {
    height: ${isAppStore ? 24 : 16}px;
    width: auto;
    display: block;
  }
  .app-img {
    display: block;
    width: 100%;
    height: auto;
  }
  .home-indicator {
    position: absolute;
    bottom: ${isAppStore ? 18 : 12}px;
    left: 50%;
    transform: translateX(-50%);
    width: ${isAppStore ? 320 : 204}px;
    height: ${isAppStore ? 10 : 7}px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.28);
    z-index: 5;
    pointer-events: none;
  }
  /* Subtle bottom vignette */
  .bottom-fade {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: ${isAppStore ? 84 : 56}px;
    background: linear-gradient(180deg, rgba(8, 9, 15, 0) 0%, rgba(8, 9, 15, 0.28) 100%);
    z-index: 6;
    pointer-events: none;
  }
</style>
</head>
<body>
  <div class="canvas">
    <div class="grid-bg"></div>
    <div class="glow-1"></div>
    <div class="glow-2"></div>
    <div class="header">
      <div class="eyebrow">
        ${slide.id === '01-hero' ? `<img class="eyebrow-icon" src="${iconDataUrl}" alt="" />` : '<span class="eyebrow-dot"></span>'}
        <span>${slide.eyebrow}</span>
      </div>
      <h1>${slide.headline}</h1>
      <p class="sub">${sub}</p>
      ${extraStrip}
    </div>
    <div class="stage">
      <div class="phone-shell">
        <div class="phone-screen">
          <img class="app-img" src="${screenDataUrl}" alt="" />
          ${statusBarSvg(isAppStore)}
          <div class="home-indicator"></div>
        </div>
      </div>
    </div>
    <div class="bottom-fade"></div>
  </div>
</body>
</html>`;
}

export function renderFeatureGraphicHtml({ lang, iconDataUrl, heroScreenUrl, diffScreenUrl }) {
  const isZh = lang === 'zh-CN';
  const title = isZh ? '你的 Agent，<br/><span>装进口袋。</span>' : 'Your agents,<br/><span>in your pocket.</span>';
  const subtitle = isZh
    ? '在手机上启动、引导与审批本地 AI Agent'
    : 'Start, steer & approve local AI agents from your phone.';
  const tags = isZh
    ? ['Claude Code · Codex · Cursor', '端到端加密', 'MIT 开源']
    : ['Claude Code · Codex · Cursor', 'E2E Encrypted', 'Open Source'];

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1024px;
    height: 500px;
    overflow: hidden;
    background: #090a11;
    font-family: ${isZh ? '"PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif' : '-apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif'};
    -webkit-font-smoothing: antialiased;
    color: #fff;
  }
  .banner {
    position: relative;
    width: 1024px;
    height: 500px;
    background: radial-gradient(95% 120% at 75% 50%, #1f234b 0%, #0d0f1b 52%, #08090f 100%);
    display: grid;
    grid-template-columns: 520px 1fr;
    align-items: center;
    padding: 0 48px 0 58px;
    overflow: hidden;
  }
  .grid {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(rgba(255, 255, 255, 0.085) 1px, transparent 1px);
    background-size: 24px 24px;
    mask-image: linear-gradient(90deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.12) 70%, transparent 100%);
  }
  .aura {
    position: absolute;
    width: 560px;
    height: 560px;
    right: -40px;
    top: -30px;
    background: radial-gradient(circle, rgba(98, 107, 240, 0.56) 0%, rgba(139, 92, 246, 0.18) 45%, transparent 72%);
    filter: blur(28px);
  }
  .left {
    position: relative;
    z-index: 3;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 22px;
  }
  .brand img {
    width: 44px;
    height: 44px;
    border-radius: 11px;
    box-shadow: 0 8px 24px rgba(90, 95, 232, 0.45);
  }
  .brand span {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #eef0ff;
  }
  h1 {
    font-size: ${isZh ? 50 : 54}px;
    font-weight: ${isZh ? 700 : 800};
    line-height: ${isZh ? 1.16 : 1.04};
    letter-spacing: ${isZh ? '-0.02em' : '-0.036em'};
  }
  h1 span {
    background: linear-gradient(135deg, #c6cdff 0%, #838cff 55%, #5f66f2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  p {
    margin-top: 14px;
    font-size: ${isZh ? 18 : 19}px;
    color: rgba(226, 230, 245, 0.74);
    line-height: 1.45;
  }
  .tags {
    margin-top: 24px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .tag {
    padding: 6px 13px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.14);
    font-size: 13px;
    font-weight: 600;
    color: rgba(240, 243, 255, 0.9);
  }
  .right {
    position: relative;
    z-index: 2;
    height: 100%;
  }
  .mock {
    position: absolute;
    padding: 8px;
    border-radius: 34px;
    background: linear-gradient(155deg, #4b5060 0%, #1a1c24 30%, #11131a 70%, #2a2d3a 100%);
    box-shadow:
      0 28px 70px rgba(0, 0, 0, 0.72),
      0 0 0 1px rgba(255, 255, 255, 0.16);
  }
  .mock .inner {
    position: relative;
    border-radius: 26px;
    overflow: hidden;
    background: #18191b;
  }
  .mock img {
    display: block;
    width: 100%;
    height: auto;
  }
  .mini-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 13%;
    max-height: 30px;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 14px;
    font-size: 8.5px;
    font-weight: 600;
    color: rgba(245, 247, 252, 0.92);
    pointer-events: none;
  }
  .mini-hole {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #000;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
  }
  .mini-icons {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 3px;
  }
  .mini-icons svg {
    height: 6.5px;
    width: auto;
    display: block;
  }
  .mock-back {
    width: 224px;
    right: -12px;
    top: 36px;
    transform: rotate(7deg);
    opacity: 0.92;
  }
  .mock-front {
    width: 248px;
    right: 138px;
    top: 16px;
    transform: rotate(-4deg);
    z-index: 2;
  }
</style>
</head>
<body>
  <div class="banner">
    <div class="grid"></div>
    <div class="aura"></div>
    <div class="left">
      <div class="brand">
        <img src="${iconDataUrl}" alt="" />
        <span>AgentDeck</span>
      </div>
      <h1>${title}</h1>
      <p>${subtitle}</p>
      <div class="tags">
        ${tags.map((t) => `<span class="tag">${t}</span>`).join('')}
      </div>
    </div>
    <div class="right">
      <div class="mock mock-back">
        <div class="inner">
          <img src="${diffScreenUrl}" alt="" />
          <div class="mini-bar">
            <span>9:41</span>
            <div class="mini-hole"></div>
            <div class="mini-icons">
              <svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="4.5" y="5" width="3" height="7" rx="1"/><rect x="9" y="2.5" width="3" height="9.5" rx="1"/><rect x="13.5" y="0" width="3" height="12" rx="1"/></svg>
              <svg viewBox="0 0 25 12" fill="none"><rect x="0.7" y="1" width="20.6" height="10" rx="2.8" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5"/><rect x="2.5" y="2.8" width="16.5" height="6.4" rx="1.4" fill="currentColor"/></svg>
            </div>
          </div>
        </div>
      </div>
      <div class="mock mock-front">
        <div class="inner">
          <img src="${heroScreenUrl}" alt="" />
          <div class="mini-bar">
            <span>9:41</span>
            <div class="mini-hole"></div>
            <div class="mini-icons">
              <svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="4.5" y="5" width="3" height="7" rx="1"/><rect x="9" y="2.5" width="3" height="9.5" rx="1"/><rect x="13.5" y="0" width="3" height="12" rx="1"/></svg>
              <svg viewBox="0 0 25 12" fill="none"><rect x="0.7" y="1" width="20.6" height="10" rx="2.8" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5"/><rect x="2.5" y="2.8" width="16.5" height="6.4" rx="1.4" fill="currentColor"/></svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
