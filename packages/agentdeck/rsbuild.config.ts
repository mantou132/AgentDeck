import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type RsbuildPlugin } from '@rsbuild/core';
import unpluginGem from 'unplugin-gem/rspack';

/**
 * `skills/<group>/<skill>/` files keyed by `<skill>/<path>`, with a content hash the host stores each version under,
 * and each skill's group, which hosts offer by name (`agentdeckd --features`).
 */
const readSkills = () => {
  const root = path.resolve(import.meta.dirname, 'skills');
  const groups: Record<string, string> = {};
  const files = Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        const [group, skill, ...rest] = path.relative(root, file).split(path.sep);
        groups[skill] = group;
        return [[skill, ...rest].join('/'), readFileSync(file, 'utf8')];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  return { hash, files, groups };
};

/** Read once per build process, so a dev server needs a restart after editing `skills/`. */
const skills = readSkills();

/**
 * Store release notes from `distribution/whatsnew`, newest first per language. The root file has no version: it
 * belongs to the latest release, older ones are archived under `history/` with their version.
 */
const readChangelog = () => {
  const root = path.resolve(import.meta.dirname, '../../distribution/whatsnew');
  const changelog: Record<string, { version?: string; text: string }[]> = {};
  const add = (dir: string, version: (rest: string) => string | undefined) => {
    for (const name of readdirSync(dir)) {
      const match = name.match(/^whatsnew-([a-z]{2}-[A-Z]{2})(?:-(.+))?$/);
      if (!match) continue;
      const [, lang, rest = ''] = match;
      changelog[lang] ??= [];
      changelog[lang].push({
        version: version(rest),
        text: readFileSync(path.join(dir, name), 'utf8').trim(),
      });
    }
  };
  add(root, () => undefined);
  add(path.join(root, 'history'), (rest) => rest);
  const parts = (version = '') => version.split('.').map(Number);
  for (const entries of Object.values(changelog)) {
    entries.sort((a, b) => {
      if (!a.version || !b.version) return a.version ? 1 : -1;
      const [x, y] = [parts(a.version), parts(b.version)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
  }
  return changelog;
};

/** Emits `skills.json` beside the app and gives the code only the hash and groups; the app fetches the file when a host lacks it. */
const skillsPlugin: RsbuildPlugin = {
  name: 'agentdeck-skills',
  setup(api) {
    api.modifyRsbuildConfig((config) => {
      config.source ??= {};
      config.source.define = {
        ...config.source.define,
        __SKILLS_HASH__: JSON.stringify(skills.hash),
        __SKILL_GROUPS__: JSON.stringify(skills.groups),
        __CHANGELOG__: JSON.stringify(readChangelog()),
      };
    });
    api.processAssets({ stage: 'additional' }, ({ compilation, sources }) => {
      const { hash, files } = skills;
      compilation.emitAsset('skills.json', new sources.RawSource(JSON.stringify({ hash, files })));
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
