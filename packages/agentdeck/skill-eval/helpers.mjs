import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Subfolders of `root` created or changed since `since`, newest first. */
export const changedDirs = (root, since) =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name))
        .filter((dir) => statSync(dir).mtimeMs >= since)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];

export const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

export const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Opens a local file in the shared browser; collects page errors and console errors into `errors`. */
export const openPage = async (ctx, file, { query = '', viewport = { width: 1920, height: 1080 } } = {}) => {
  const page = await ctx.browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${pathToFileURL(file).href}${query}`, { waitUntil: 'load' });
  return { page, errors };
};

/** Screenshots the page into the case folder and adds it to the report. */
export const shoot = async (ctx, page, label) => {
  const file = `shot-${ctx.shots.length + 1}.jpg`;
  await page.screenshot({ path: path.join(ctx.caseDir, file), type: 'jpeg', quality: 60 });
  ctx.shots.push({ file, label });
};

/** Page count of a PDF, from its page objects. */
export const pdfPages = (file) => (readFileSync(file, 'latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
