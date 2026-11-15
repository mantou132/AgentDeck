// Runs each skill's fixed cases with the free agent (managed OpenCode + a free model), checks the results and
// writes a report. Usage: `pnpm skill-eval [skill …] [--all]`; without arguments, the skills changed since the
// latest release tag. Outputs land in the real workspaces; the run's report and transcripts in ~/SkillEval/<time>/.

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const pkgDir = path.resolve(import.meta.dirname, '..');
const skillsDir = path.join(pkgDir, 'skills');
const appData = path.join(homedir(), 'Library/Application Support/agentdeck');
const model = process.env.SKILL_EVAL_MODEL ?? 'opencode/deepseek-v4.1-flash-free';
const turnTimeout = 30 * 60_000;
const nudge = '继续，按你的判断做完并交付，不用再问我。';

const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
const runDir = path.join(homedir(), 'SkillEval', stamp);

/** `<skill>` → `skills/<group>/<skill>` */
const skillSources = Object.fromEntries(
  readdirSync(skillsDir).flatMap((group) =>
    readdirSync(path.join(skillsDir, group)).map((skill) => [skill, path.join(skillsDir, group, skill)]),
  ),
);

const git = (...args) => execFileSync('git', args, { cwd: pkgDir, encoding: 'utf8' }).trim();

/** Skills with files changed since the latest release tag, committed or not. */
const changedSkills = () => {
  const tag = git('describe', '--tags', '--abbrev=0');
  const files = [
    ...git('diff', '--name-only', tag, '--', 'skills').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard', '--', 'skills').split('\n'),
  ];
  const prefix = git('rev-parse', '--show-prefix');
  const skills = files
    .filter(Boolean)
    .map((file) => path.relative(`${prefix}skills`, file).split('/')[1])
    .filter((skill) => skill in skillSources);
  console.log(`Changed since ${tag}: ${[...new Set(skills)].join(', ') || 'none'}`);
  return skills;
};

const latestOpenCode = () => {
  const dir = path.join(appData, 'agents/opencode/versions');
  const [version] = readdirSync(dir).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return path.join(dir, version, 'opencode');
};

/** Renders every skill the way agentdeckd installs a version, so the free agent sees all of them. */
const renderSkills = () => {
  const root = path.join(runDir, 'skills');
  return Object.entries(skillSources).map(([skill, source]) => {
    const target = path.join(root, skill, '.agents/skills', skill);
    cpSync(source, target, { recursive: true });
    const learned = path.join(appData, 'skills/learned', skill, 'learned.md');
    const fill = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) fill(file);
        else {
          const text = readFileSync(file, 'utf8');
          if (text.includes('{{LEARNED_PATH}}')) writeFileSync(file, text.replaceAll('{{LEARNED_PATH}}', learned));
        }
      }
    };
    fill(target);
    return path.join(root, skill, '.agents/skills');
  });
};

/** One `opencode run`; resolves with its JSON events. */
const runTurn = ({ bin, message, session, cwd, env, logFile }) =>
  new Promise((resolve) => {
    const args = ['run', '--standalone', '--format', 'json', '--auto', '-m', model];
    if (session) args.push('-s', session);
    const child = spawn(bin, [...args, message], { cwd, env });
    const events = [];
    let buffer = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      events.push({ type: 'error', part: { text: `Turn timed out after ${turnTimeout / 60_000} min` } });
      child.kill();
    }, turnTimeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(logFile, stderr, { flag: 'a' });
      if (code) events.push({ type: 'error', part: { text: `opencode exited with ${code}: ${stderr.slice(-500)}` } });
      resolve(events);
    });
  });

const browserPath = () =>
  process.env.SKILL_EVAL_CHROME ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].find(existsSync);

/** Folders each case produced in real workspaces last time, keyed by `<skill>/<case>`. */
const outputsFile = path.join(homedir(), 'SkillEval', 'outputs.json');
const outputs = existsSync(outputsFile) ? JSON.parse(readFileSync(outputsFile, 'utf8')) : {};

/** Moves what the previous run of a case left in a real workspace into ~/SkillEval/old/, so the rerun starts fresh. */
const shelvePrevious = (key) => {
  for (const dir of outputs[key] ?? []) {
    if (!existsSync(dir)) continue;
    const target = path.join(homedir(), 'SkillEval', 'old', `${path.basename(dir)}-${stamp}`);
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(dir, target);
  }
  delete outputs[key];
};

const runCase = async ({ skill, testCase, bin, skillPaths, browser }) => {
  const key = `${skill}/${testCase.id}`;
  shelvePrevious(key);
  const caseDir = path.join(runDir, skill, testCase.id);
  mkdirSync(caseDir, { recursive: true });
  const home = testCase.home ? path.join(homedir(), 'SkillEval', 'homes', skill) : homedir();
  const cwd = path.join(caseDir, 'cwd');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const ctx = {
    home,
    caseDir,
    browser,
    startedAt: Date.now(),
    fixtures: path.join(import.meta.dirname, 'fixtures', skill),
    shots: [],
    outputs: [],
  };
  await testCase.setup?.(ctx);
  const env = {
    ...process.env,
    HOME: home,
    OPENCODE_DB: path.join(caseDir, 'opencode.db'),
    OPENCODE_AUTH_CONTENT: '{}',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ['opencode'], skills: { paths: skillPaths } }),
  };

  const turns = [];
  ctx.turns = turns;
  let session;
  const send = async (message) => {
    console.log(`  › ${message.slice(0, 60)}`);
    const events = await runTurn({ bin, message, session, cwd, env, logFile: path.join(caseDir, 'opencode.log') });
    session ??= events.find((event) => event.sessionID)?.sessionID;
    turns.push({ message, events });
  };
  for (const message of testCase.turns) await send(message);
  for (let i = 0; i < 2 && !(await testCase.done(ctx)); i++) await send(nudge);

  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
  try {
    await testCase.check(ctx, check);
  } catch (error) {
    check('检查脚本出错', false, String(error?.stack ?? error));
  }
  outputs[key] = ctx.outputs;
  writeFileSync(outputsFile, JSON.stringify(outputs, null, 2));
  const result = {
    skill,
    id: testCase.id,
    title: testCase.title,
    ms: Date.now() - ctx.startedAt,
    turns,
    checks,
    shots: ctx.shots,
    outputs: ctx.outputs,
  };
  writeFileSync(path.join(caseDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const turnHtml = ({ message, events }) => {
  const parts = events.map(({ type, part }) => {
    if (type === 'text') return `<div class="text">${escapeHtml(part.text)}</div>`;
    if (type === 'tool_use') {
      const input = JSON.stringify(part.state?.input ?? {});
      return `<div class="tool">${escapeHtml(part.tool)} ${escapeHtml(input.slice(0, 300))}</div>`;
    }
    if (type === 'error') return `<div class="error">${escapeHtml(part.text ?? JSON.stringify(part))}</div>`;
    return '';
  });
  return `<div class="user">${escapeHtml(message)}</div>${parts.join('')}`;
};

const tokens = (turns) =>
  turns
    .flatMap((turn) => turn.events)
    .filter((event) => event.type === 'step_finish')
    .reduce((sum, event) => sum + (event.part.tokens?.input ?? 0) + (event.part.tokens?.output ?? 0), 0);

const writeReport = (results) => {
  const mark = (ok) => (ok === true ? '✅' : ok === 'warn' ? '⚠️' : '❌');
  const sections = results.map((result) => {
    const base = path.join(result.skill, result.id);
    const shots = result.shots
      .map(
        (shot) =>
          `<figure><img src="${escapeHtml(path.join(base, shot.file))}" loading="lazy"><figcaption>${escapeHtml(shot.label)}</figcaption></figure>`,
      )
      .join('');
    const checks = result.checks
      .map((c) => `<li>${mark(c.ok)} ${escapeHtml(c.name)}${c.detail ? `<small>${escapeHtml(c.detail)}</small>` : ''}</li>`)
      .join('');
    return `<section><h2>${escapeHtml(result.skill)} · ${escapeHtml(result.title)}</h2>
<p class="meta">${Math.round(result.ms / 60_000)} 分钟 · ${result.turns.length} 轮 · ${tokens(result.turns).toLocaleString()} tokens</p>
${result.outputs.map((dir) => `<p class="meta">输出：${escapeHtml(dir)}</p>`).join('')}
<ul class="checks">${checks}</ul><div class="shots">${shots}</div>
<details><summary>对话记录</summary>${result.turns.map(turnHtml).join('')}</details></section>`;
  });
  const failed = results.flatMap((r) => r.checks).filter((c) => c.ok === false).length;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill eval ${stamp}</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:960px;color:#222}
h1{font-size:20px}h2{font-size:17px;margin:24px 0 4px}.meta{color:#666;margin:0}
.checks{padding:0;list-style:none}.checks li{margin:4px 0}small{display:block;color:#666;margin-left:24px;white-space:pre-wrap}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
figure{margin:0}img{width:100%;border:1px solid #ddd}figcaption{font-size:12px;color:#666}
.user{background:#e8f0fe;padding:8px;margin:12px 0 4px;border-radius:6px;white-space:pre-wrap}
.text{white-space:pre-wrap;margin:4px 0}.tool{font:12px monospace;color:#666;overflow-wrap:anywhere}
.error{color:#c00;white-space:pre-wrap}</style></head><body>
<h1>Skill eval · ${stamp}</h1><p>模型 ${escapeHtml(model)} · ${results.length} 题 · ${failed ? `${failed} 项未通过` : '全部通过'}</p>
${sections.join('')}</body></html>`;
  const file = path.join(runDir, 'report.html');
  writeFileSync(file, html);
  return file;
};

const args = process.argv.slice(2);
const requested = args.includes('--all') ? Object.keys(skillSources) : args.length ? args : changedSkills();
const suites = [];
for (const skill of new Set(requested)) {
  const file = path.join(import.meta.dirname, 'cases', `${skill}.mjs`);
  if (existsSync(file)) suites.push({ skill, cases: (await import(file)).default });
  else console.log(`No cases for ${skill}, skipped`);
}
if (!suites.length) process.exit(0);

mkdirSync(runDir, { recursive: true });
const bin = process.env.SKILL_EVAL_OPENCODE ?? latestOpenCode();
const skillPaths = renderSkills();
const browser = await chromium.launch({ executablePath: browserPath() });
const results = [];
try {
  for (const { skill, cases } of suites) {
    for (const testCase of cases) {
      console.log(`${skill} · ${testCase.title}`);
      results.push(await runCase({ skill, testCase, bin, skillPaths, browser }));
      writeReport(results);
    }
  }
} finally {
  await browser.close();
}
console.log(`Report: ${writeReport(results)}`);
