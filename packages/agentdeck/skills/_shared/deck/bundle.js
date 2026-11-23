#!/usr/bin/env node
/**
 * Single-file packager for presentation and courseware decks.
 * Inlines local CSS stylesheets, local JavaScript scripts, and local images (as Base64).
 * Preserves external CDN imports (KaTeX, Three.js, etc.).
 *
 * Usage:
 *   node bundle.js index.html -o deliverable.html
 *   node bundle.js index.html deliverable.html
 */

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node bundle.js <input.html> [-o <output.html>]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

let inputPath = null;
let outputPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--output') {
    outputPath = args[++i];
  } else if (!inputPath) {
    inputPath = args[i];
  } else if (!outputPath) {
    outputPath = args[i];
  }
}

if (!inputPath) usage();
if (!outputPath) {
  const parsed = path.parse(inputPath);
  outputPath = path.join(parsed.dir, `${parsed.name}.bundle.html`);
}

const baseDir = path.dirname(path.resolve(inputPath));
let html = fs.readFileSync(inputPath, 'utf8');

const isRemote = (url) => /^(https?:|\/\/|data:)/i.test(url.trim());

// 1. Inline local images: <img ... src="..." ...>
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

html = html.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, before, src, after) => {
  if (isRemote(src)) return match;
  const filePath = path.resolve(baseDir, src);
  if (!fs.existsSync(filePath)) {
    console.warn(`[bundle] Warning: image file not found: ${src}`);
    return match;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const base64 = fs.readFileSync(filePath).toString('base64');
  return `<img ${before}src="data:${mime};base64,${base64}"${after}>`;
});

// 2. Inline local stylesheets: <link rel="stylesheet" href="...">
html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, (match) => {
  const hrefMatch = match.match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return match;
  const href = hrefMatch[1];
  if (isRemote(href)) return match;

  const filePath = path.resolve(baseDir, href);
  if (!fs.existsSync(filePath)) {
    console.warn(`[bundle] Warning: CSS file not found: ${href}`);
    return match;
  }
  const css = fs.readFileSync(filePath, 'utf8');
  return `<style>\n${css}\n</style>`;
});

// Also match <link href="..." rel="stylesheet">
html = html.replace(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi, (match, href) => {
  if (isRemote(href)) return match;
  const filePath = path.resolve(baseDir, href);
  if (!fs.existsSync(filePath)) return match;
  const css = fs.readFileSync(filePath, 'utf8');
  return `<style>\n${css}\n</style>`;
});

// 3. Inline local scripts: <script src="..."></script>
html = html.replace(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (match, src) => {
  if (isRemote(src)) return match;
  const filePath = path.resolve(baseDir, src);
  if (!fs.existsSync(filePath)) {
    console.warn(`[bundle] Warning: JS file not found: ${src}`);
    return match;
  }
  let js = fs.readFileSync(filePath, 'utf8');
  // Escape inline </script> to avoid breaking enclosing script tag
  js = js.replace(/<\/script>/gi, '<\\/script>');
  return `<script>\n${js}\n</script>`;
});

fs.writeFileSync(outputPath, html, 'utf8');
const stat = fs.statSync(outputPath);
console.log(`[bundle] Successfully generated single-file deck: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`);
