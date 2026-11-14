import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type RsbuildPlugin } from '@rsbuild/core';
import unpluginGem from 'unplugin-gem/rspack';

/** `skills/` files keyed by relative path, with a content hash the host stores each version under. */
const readSkills = () => {
  const root = path.resolve(import.meta.dirname, 'skills');
  const files = Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file).split(path.sep).join('/'), readFileSync(file, 'utf8')];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  return { hash, files };
};

/** Read once per build process, so a dev server needs a restart after editing `skills/`. */
const skills = readSkills();

/** Emits `skills.json` beside the app and gives the code only the hash; the app fetches the file when a host lacks it. */
const skillsPlugin: RsbuildPlugin = {
  name: 'agentdeck-skills',
  setup(api) {
    api.modifyRsbuildConfig((config) => {
      config.source ??= {};
      config.source.define = { ...config.source.define, __SKILLS_HASH__: JSON.stringify(skills.hash) };
    });
    api.processAssets({ stage: 'additional' }, ({ compilation, sources }) => {
      compilation.emitAsset('skills.json', new sources.RawSource(JSON.stringify(skills)));
    });
  },
};

export default defineConfig(({ command }) => ({
  plugins: [skillsPlugin],
  html: {
    template: './index.html',
  },
  source: {
    entry: {
      index: './src/main.ts',
    },
  },
  output: {
    distPath: {
      root: 'dist',
    },
    // Loaded at runtime by `elements/map.ts`, so the main thread and the worker share these modules.
    copy: ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'].map((file) => ({
      from: path.resolve(import.meta.dirname, 'node_modules/maplibre-gl/dist', file),
      to: 'maplibre',
    })),
  },
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
  },
  tools: {
    rspack: {
      target: ['web', 'es2022'],
      plugins: [
        unpluginGem({
          include: path.resolve(import.meta.dirname, 'src'),
          styleMinify: true,
          htmlMinify: true,
          autoImport: {
            extends: 'gem',
            elements: {
              '@mantou/tap-ui': {
                'tap-active-link': '/elements/link',
                'tap-light-route': '/elements/route',
                'tap-(cell|input|checkbox|radio|list|collapse)-*': '/elements/$1',
                'tap-*': '/elements/*',
              },
              'src/elements': {
                'deck-(sheet|file-browser|changes-diff|changes|git-log|screen|map)-*': '/$1',
                'deck-*': '/*',
              },
            },
          },
          autoImportDts: true,
          hmr: command !== 'build',
        }),
      ],
    },
  },
}));
