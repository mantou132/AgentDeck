#!/usr/bin/env node
/**
 * Extracts speaker notes from HTML slides into a clean, portable script.md.
 * Eliminates redundant LLM generation tokens: index.html is the single source of truth.
 *
 * Usage:
 *   node export-script.js <input.html> [-o output.md]
 */

import fs from 'node:fs';
import path from 'node:path';

function printHelp() {
  console.log(`
Usage:
  node export-script.js <input.html> [-o output.md]

Options:
  -o, --output <file>  Target markdown path (default: stdout or script.md next to input)
  -h, --help           Show this message
`);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  printHelp();
  process.exit(0);
}

const inputPath = path.resolve(args[0]);
let outputPath = null;

for (let i = 1; i < args.length; i++) {
  if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) {
    outputPath = path.resolve(args[++i]);
  }
}

if (!outputPath) {
  const dir = path.dirname(inputPath);
  outputPath = path.join(dir, 'script.md');
}

if (!fs.existsSync(inputPath)) {
  console.error(`Error: input file "${inputPath}" not found.`);
  process.exit(1);
}

const html = fs.readFileSync(inputPath, 'utf8');

// Extract document title
const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
const docTitle = titleMatch ? titleMatch[1].trim() : path.basename(inputPath, path.extname(inputPath));

// Match all slides: <section class="slide...">...</section>
const slideRegex = /<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi;
const slides = [...html.matchAll(slideRegex)].map((m) => m[1]);

if (!slides.length) {
  console.error('Warning: No slides found in input HTML.');
  process.exit(0);
}

function cleanHtmlToMarkdown(content) {
  let text = content;
  // Convert HTML entity quotes and tags
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // Convert <strong> / <b> to **
  text = text.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  // Convert <em> / <i> to *
  text = text.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');
  // Convert <code> to `
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Convert <br> to newline
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Convert <p>...</p> to clean trimmed paragraphs
  text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, p) => {
    const cleanLines = p
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('  \n');
    return `${cleanLines}\n\n`;
  });
  // Strip any remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Trim every line to eliminate HTML tag indentations
  text = text
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  // Strip trailing divider from notes text if already present
  text = text.replace(/(?:\n|^)---\s*$/g, '').trim();
  // Normalize whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function getSlideHeading(slideHtml, index) {
  const h1 = slideHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, '').trim();

  const h2 = slideHtml.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) return h2[1].replace(/<[^>]+>/g, '').trim();

  const stmt = slideHtml.match(/<p\b[^>]*class=["'][^"']*statement[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
  if (stmt)
    return stmt[1]
      .replace(/<[^>]+>/g, '')
      .trim()
      .slice(0, 30);

  return `第 ${index + 1} 页`;
}

let md = `# ${docTitle} · 演讲逐字稿\n\n`;

slides.forEach((slideHtml, i) => {
  const heading = getSlideHeading(slideHtml, i);
  md += `## ${i + 1} · ${heading}\n\n`;

  const notesMatch = slideHtml.match(/<aside\b[^>]*\bclass=["'][^"']*\bnotes\b[^"']*["'][^>]*>([\s\S]*?)<\/aside>/i);
  if (notesMatch) {
    const notesContent = cleanHtmlToMarkdown(notesMatch[1]);
    md += `${notesContent}\n\n`;
  } else {
    md += `*（本页无逐字讲稿）*\n\n`;
  }

  if (i < slides.length - 1) {
    md += `---\n\n`;
  }
});

fs.writeFileSync(outputPath, md, 'utf8');
console.log(`[export-script] Successfully extracted ${slides.length} slides to: ${outputPath}`);
