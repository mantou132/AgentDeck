#!/usr/bin/env node
/**
 * Headless Chromium PDF exporter for resumes, courseware, and presentations.
 * Automatically discovers Chrome, Edge, or Chromium on macOS, Linux, and Windows.
 *
 * Usage:
 *   node export-pdf.js <input.html> <output.pdf> [--landscape] [--wait=3000]
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findChromium() {
  const platform = os.platform();

  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Arc.app/Contents/MacOS/Arc',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${os.homedir()}/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
      `${os.homedir()}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
      `${os.homedir()}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    // Linux / other
    const bins = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'microsoft-edge'];
    for (const bin of bins) {
      try {
        const found = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (found && fs.existsSync(found)) return found;
      } catch (_e) {
        // try next
      }
    }
  }

  // Fallback to CHROME_PATH or BROWSER env vars
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  return null;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node export-pdf.js <input.html> <output.pdf> [--landscape] [--wait=3000]');
  process.exit(1);
}

let input = null;
let output = null;
let landscape = false;
let waitMs = null;

for (const arg of args) {
  if (arg === '--landscape') {
    landscape = true;
  } else if (arg.startsWith('--wait=')) {
    waitMs = parseInt(arg.split('=')[1], 10);
  } else if (!input) {
    input = arg;
  } else if (!output) {
    output = arg;
  }
}

if (!input || !output) {
  console.error('Error: Both input HTML and output PDF paths are required.');
  process.exit(1);
}

const chromeBin = findChromium();
if (!chromeBin) {
  console.error('Error: No Chromium-based browser (Google Chrome, Microsoft Edge, Chromium) found on this machine.');
  process.exit(1);
}

const inputAbs = path.resolve(input);
const outputAbs = path.resolve(output);

if (!fs.existsSync(inputAbs)) {
  console.error(`Error: Input file does not exist: ${inputAbs}`);
  process.exit(1);
}

const chromeArgs = [
  '--headless',
  '--no-pdf-header-footer',
  '--disable-gpu',
  '--no-sandbox',
  `--print-to-pdf=${outputAbs}`,
];

if (landscape) {
  // Landscape orientation
  chromeArgs.push('--print-to-pdf-margin-top=0', '--print-to-pdf-margin-bottom=0');
}

if (waitMs && waitMs > 0) {
  chromeArgs.push(`--virtual-time-budget=${waitMs}`);
}

chromeArgs.push(inputAbs.startsWith('http') ? inputAbs : `file://${inputAbs}`);

try {
  execFileSync(chromeBin, chromeArgs, { stdio: 'pipe' });
  if (fs.existsSync(outputAbs)) {
    const size = fs.statSync(outputAbs).size;
    console.log(`[export-pdf] Successfully exported PDF: ${outputAbs} (${(size / 1024).toFixed(1)} KB)`);
  } else {
    console.error('[export-pdf] Command finished but output PDF was not found.');
    process.exit(1);
  }
} catch (err) {
  console.error('[export-pdf] Export failed:', err.message);
  process.exit(1);
}
