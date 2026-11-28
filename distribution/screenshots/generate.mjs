#!/usr/bin/env node
/**
 * Captures real 3x Retina screenshots from the built AgentDeck frontend using
 * an in-memory mock Relay WebSocket, then renders studio-grade store graphics
 * for App Store (1320x2868) and Google Play (1080x1920 + 1024x500 feature graphic)
 * in both English and Simplified Chinese.
 *
 * Usage:
 *   node distribution/screenshots/generate.mjs
 *   node distribution/screenshots/generate.mjs --compose-only
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../packages/agentdeck/node_modules/@playwright/test/index.mjs';
import { getSlides, renderFeatureGraphicHtml, renderSlideHtml } from './composer.mjs';
import { createMockData } from './mock-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const distDir = path.join(repoRoot, 'packages/agentdeck/dist');
const iconPath = path.join(repoRoot, 'packages/agentdeck/public/agentdeck-icon.png');
const rawDir = path.join(__dirname, 'raw');
const outDir = path.join(__dirname, 'out');

const CHROME_CANDIDATES = [
  process.env.E2E_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) {
  throw new Error('No Chrome/Chromium binary found. Set E2E_CHROME_PATH.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(rootDir, 'index.html');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function attachMockRelay(page, mock) {
  let seq = 0;
  return page.routeWebSocket(/ws:\/\/127\.0\.0\.1\/mock-relay/, (ws) => {
    const deliver = (payload) => {
      seq += 1;
      ws.send(
        JSON.stringify({
          type: 'message',
          message_id: `mock-${seq}`,
          sequence: seq,
          payload,
        }),
      );
    };

    const reply = (id, result) => deliver({ id, result, peerId: 1 });

    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'ready', endpoint: '2', peers: ['host'] }));
    }, 10);

    ws.onMessage((raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type !== 'message') return;
      if (frame.message_id) {
        ws.send(JSON.stringify({ type: 'ack', message_id: frame.message_id }));
      }
      const rpc = frame.payload;
      if (!rpc?.method) return;
      const { id, method, params = {} } = rpc;

      switch (method) {
        case 'peer_attach':
          reply(id, {
            peerId: 1,
            version: '1.0.0',
            hostname: mock.hostname,
            home: mock.home,
            customAgents: [],
            skillsMissing: false,
            restrictedFeatures: [],
          });
          break;
        case 'agent_active_sessions':
          reply(id, {
            sessions: mock.activeSessions,
            userInputs: mock.pendingUserInputs,
          });
          break;
        case 'agent_session_list':
          reply(id, { sessions: mock.sessions });
          break;
        case 'task_list':
          reply(id, { tasks: mock.tasks });
          break;
        case 'task_runs':
          reply(id, { runs: mock.taskRuns[params.id] || [] });
          break;
        case 'agent_session_open': {
          const entry = mock.sessionEvents[params.sessionId] || {
            running: false,
            userInputs: [],
            suggestion: null,
            events: [],
          };
          const meta = mock.sessions.find((s) => s.sessionId === params.sessionId);
          if (entry.events.length) {
            deliver({ id, event: { events: entry.events }, peerId: 1 });
          }
          reply(id, {
            agent: params.agent || 'claude-acp',
            sessionId: params.sessionId,
            epoch: 'ep-mock-1',
            seq: entry.events.length,
            title: meta?.title,
            updatedAt: meta?.updatedAt,
            modes: null,
            configOptions: mock.configOptions,
            running: entry.running,
            userInputs: entry.userInputs,
            suggestion: entry.suggestion,
            fullReplay: true,
            freshLoad: false,
          });
          break;
        }
        case 'agent_session_unsubscribe':
        case 'agent_session_set_unread':
          reply(id, { ok: true });
          break;
        case 'git_status':
          reply(id, mock.gitStatus);
          break;
        case 'git_diff':
          reply(id, mock.gitDiff);
          break;
        default:
          reply(id, {});
      }
    });
  });
}

async function captureRawScreens(browser, baseUrl, lang) {
  const mock = createMockData(lang);
  const langRawDir = path.join(rawDir, lang);
  fs.mkdirSync(langRawDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    locale: lang,
    timezoneId: lang === 'zh-CN' ? 'Asia/Shanghai' : 'America/New_York',
  });

  await context.addInitScript(
    ({ langCode, hostname, home }) => {
      localStorage.setItem(
        'agentdeck.settings.v1',
        JSON.stringify({
          relayId: '01234567-89ab-cdef-0123-456789abcdef',
          agent: 'claude-acp',
          relayUrl: 'ws://127.0.0.1/mock-relay',
        }),
      );
      localStorage.setItem('agentdeck.language.v1', langCode);
      localStorage.setItem('agentdeck.relay_guide_seen.v1', '1');
      localStorage.setItem(
        'agentdeck.pairing_history.v1',
        JSON.stringify([
          {
            relayId: '01234567-89ab-cdef-0123-456789abcdef',
            relayUrl: 'ws://127.0.0.1/mock-relay',
            hostname,
            home,
            agent: 'claude-acp',
          },
        ]),
      );
    },
    { langCode: lang, hostname: mock.hostname, home: mock.home },
  );

  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`  [pageerror ${lang}]`, err.message));
  await attachMockRelay(page, mock);

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.addStyleTag({
    content: `
      :root {
        --safe-area-inset-top: 54px !important;
        --safe-area-inset-bottom: 24px !important;
      }
    `,
  });

  // Wait for sessions and tasks to render on the home list
  await page.waitForSelector('deck-task-group', { timeout: 15_000 });
  await page.waitForSelector('deck-session-group', { timeout: 15_000 });
  await page.waitForTimeout(500);

  const shot = async (name) => {
    const file = path.join(langRawDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  captured raw/${lang}/${name}.png`);
    return file;
  };

  // 1) Session List (03-sessions)
  await shot('03-sessions');

  // Helper to pop the topmost tap-stack page and wait for its unmount
  const popBack = async (selectorToWaitGone) => {
    await page.evaluate(() => window.history.back());
    if (selectorToWaitGone) {
      await page.waitForFunction((sel) => !document.querySelector(sel), selectorToWaitGone, { timeout: 10_000 });
    }
    await page.waitForTimeout(250);
  };

  // 2) Hero Chat (01-chat)
  await page.getByText(mock.sessions[0].title, { exact: false }).first().tap();
  await page.waitForSelector('deck-session-timeline', { timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot('01-chat');

  // 3) Git Diff (04-diff) — click cwd in session header, then click refresh.ts
  await page.locator('agentdeck-session-page button', { hasText: '~/workspace/agentdeck' }).first().tap();
  await page.waitForSelector('deck-changes-page', { timeout: 10_000 });
  await page.waitForTimeout(600);
  await page.locator('deck-changes-page').getByText('src/auth/refresh.ts', { exact: false }).first().tap();
  await page.waitForSelector('gem-bind-diff2html', { timeout: 15_000 });
  await page.waitForTimeout(900);
  await shot('04-diff');

  // Pop diff -> changes -> session back to list
  await popBack('deck-changes-diff-page');
  await popBack('deck-changes-page');
  await popBack('agentdeck-session-page');

  // 4) Permission Request (02-approve)
  await page.getByText(mock.sessions[1].title, { exact: false }).first().tap();
  await page.waitForSelector('deck-permission-request', { timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot('02-approve');
  await popBack('agentdeck-session-page');

  // 5) Interactive ECharts inside Chat (05-chart)
  await page.getByText(mock.sessions[2].title, { exact: false }).first().tap();
  await page.waitForSelector('deck-chart', { timeout: 10_000 });
  // Wait for lazy-loaded ECharts canvas or SVG to mount inside shadow DOM
  await page.locator('deck-chart canvas, deck-chart svg').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(900);
  await shot('05-chart');
  await popBack('agentdeck-session-page');

  // 6) Scheduled Task Detail Page (06-tasks)
  await page.locator('deck-task-group').getByText(mock.tasks[0].name, { exact: false }).first().tap();
  await page.waitForSelector('deck-task-page', { timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot('06-tasks');

  await context.close();
}

const toDataUrl = (filePath) => `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;

async function composeAll(browser) {
  const iconDataUrl = toDataUrl(iconPath);

  const targets = [
    { platform: 'appstore', lang: 'en-US', folder: 'appstore/en-US', width: 1320, height: 2868 },
    { platform: 'appstore', lang: 'zh-CN', folder: 'appstore/zh-Hans', width: 1320, height: 2868 },
    { platform: 'appstore', lang: 'en-US', folder: 'appstore-6.3/en-US', width: 1206, height: 2622 },
    { platform: 'appstore', lang: 'zh-CN', folder: 'appstore-6.3/zh-Hans', width: 1206, height: 2622 },
    { platform: 'googleplay', lang: 'en-US', folder: 'googleplay/en-US', width: 1080, height: 1920 },
    { platform: 'googleplay', lang: 'zh-CN', folder: 'googleplay/zh-CN', width: 1080, height: 1920 },
  ];

  for (const target of targets) {
    const destDir = path.join(outDir, target.folder);
    fs.mkdirSync(destDir, { recursive: true });
    const page = await browser.newPage({
      viewport: { width: target.width, height: target.height },
      deviceScaleFactor: 1,
    });

    for (const slide of getSlides(target.lang)) {
      const screenFile = path.join(rawDir, target.lang, `${slide.raw}.png`);
      const html = renderSlideHtml({
        slide,
        platform: target.platform,
        lang: target.lang,
        screenDataUrl: toDataUrl(screenFile),
        iconDataUrl,
        width: target.width,
        height: target.height,
      });
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForTimeout(100);
      const outFile = path.join(destDir, `${slide.id}.png`);
      await page.screenshot({ path: outFile });
      console.log(`  rendered out/${target.folder}/${slide.id}.png (${target.width}x${target.height})`);
    }
    await page.close();
  }

  // Google Play Feature Graphics (1024 x 500)
  const fgPage = await browser.newPage({
    viewport: { width: 1024, height: 500 },
    deviceScaleFactor: 1,
  });
  for (const lang of ['en-US', 'zh-CN']) {
    const html = renderFeatureGraphicHtml({
      lang,
      iconDataUrl,
      heroScreenUrl: toDataUrl(path.join(rawDir, lang, '01-chat.png')),
      diffScreenUrl: toDataUrl(path.join(rawDir, lang, '04-diff.png')),
    });
    await fgPage.setContent(html, { waitUntil: 'load' });
    await fgPage.waitForTimeout(100);
    const outFile = path.join(outDir, `googleplay/${lang}/feature-graphic.png`);
    await fgPage.screenshot({ path: outFile });
    console.log(`  rendered out/googleplay/${lang}/feature-graphic.png (1024x500)`);
  }
  await fgPage.close();
}

async function main() {
  const composeOnly = process.argv.includes('--compose-only');
  let server;
  let baseUrl;
  if (!composeOnly) {
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      throw new Error(`Missing built frontend at ${distDir}. Run "pnpm --filter agentdeck build" first.`);
    }
    ({ server, baseUrl } = await startStaticServer(distDir));
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    if (!composeOnly) {
      for (const lang of ['en-US', 'zh-CN']) {
        console.log(`Capturing real app screens (${lang})...`);
        await captureRawScreens(browser, baseUrl, lang);
      }
    }
    console.log('Composing store marketing screenshots...');
    await composeAll(browser);
    console.log('Done! Output in:', outDir);
  } finally {
    await browser.close();
    server?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
