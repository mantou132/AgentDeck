import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import unpluginGem from 'unplugin-gem/rspack';

export default defineConfig(({ command }) => ({
  html: { template: './index.html' },
  source: { entry: { index: './src/main.ts' } },
  // Relative asset URLs, so `dist/index.html` also works from any directory
  output: { assetPrefix: './' },
  tools: {
    rspack: {
      target: ['web', 'es2022'],
      plugins: [
        unpluginGem({
          include: path.resolve(import.meta.dirname, 'src'),
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
                'app-*': '/*',
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
