// @gem-bind/diff2html fetches styles from jsdelivr/cdnjs at runtime; network disconnection would break the page.
// Rewrite CDN URLs to local copies under public/vendor at build time;
// Throw an error directly if upstream changes loading mechanism and URLs disappear, avoiding silent failures.
const DIFF_CSS_CDN = `'https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css'`;
const DIFF_CSS_LOCAL = `'/vendor/diff2html/diff2html.min.css'`;
const HLJS_CSS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/';
const HLJS_CSS_LOCAL = '/vendor/highlightjs/';

/** @type {import('webpack').Loader} */
export default function diff2htmlLocal(content) {
  for (const cdn of [DIFF_CSS_CDN, HLJS_CSS_CDN]) {
    if (!content.includes(cdn)) {
      throw new Error('diff2html-local: CDN 地址在 @gem-bind/diff2html 中找不到，上游可能已变更');
    }
  }
  return content.replaceAll(DIFF_CSS_CDN, DIFF_CSS_LOCAL).replaceAll(HLJS_CSS_CDN, HLJS_CSS_LOCAL);
}
