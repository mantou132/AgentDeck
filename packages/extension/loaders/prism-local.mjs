// dy-code-block loads Prism from esm.sh at runtime, but extension page CSP does not allow remote scripts.
// Rewrite its CDN URL to a local copy under public/vendor/prismjs at build time;
// Throw an error directly if upstream upgrade removes the pattern, avoiding silent failures.
const CDN = `'https://esm.sh/prismjs@v1.26.0'`;
const ROOT_URL = `'/vendor/prismjs'`;
const CORE_URL = `'/vendor/prismjs/index.mjs'`;

/** @type {import('webpack').Loader} */
export default function prismLocal(content) {
  if (!content.includes(CDN)) {
    throw new Error('prism-local: esm.sh 地址在 duoyun-ui/elements/code-block.js 中找不到，上游可能已变更');
  }
  return (
    content
      .replaceAll(CDN, ROOT_URL)
      // Core import is a bare `import(...prismjs)`, which needs to point to a specific file
      .replace(/prismjs\)\s*;/, `${CORE_URL});`)
  );
}
