import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import unpluginGem from 'unplugin-gem/rspack';

export default defineConfig(({ command }) => ({
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
