/** @type {import('extension').FileConfig} */

const profile = (name) => `./dist/extension-profile-${name}`;

export default {
  commands: {
    dev: {
      browser: 'chrome',
      startingUrl: 'https://example.com',
      profile: profile('chrome'),
    },
    build: {
      browser: 'chrome,firefox',
      zip: true,
    },
  },
  config(config) {
    config.target = ['web', 'es2024', 'browserslist:chrome >= 125, firefox >= 128'];
    config.optimization ??= {};
    config.optimization.splitChunks = {
      ...config.optimization.splitChunks,
      cacheGroups: {
        ...config.optimization.splitChunks?.cacheGroups,
        mermaidParser: {
          test: /[\\/]@mermaid-js[\\/]parser[\\/]/,
          name: 'mermaid-parser',
          chunks: 'async',
          minChunks: 2,
          priority: 30,
          reuseExistingChunk: true,
          enforce: true,
        },
      },
    };
    config.module ??= {};
    config.module.rules ??= [];
    // Compile TypeScript from workspace and relay-client-ts
    config.module.rules.unshift({
      test: /\.ts$/,
      use: [
        {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              target: 'es2024',
              parser: { syntax: 'typescript', decorators: true },
              transform: { decoratorVersion: '2023-11' },
            },
          },
        },
      ],
    });
    // dy-code-block 的 Prism 改为本地 vendor，见 loaders/prism-local.mjs
    config.module.rules.unshift({
      test: /\.js$/,
      include: (filename) => /[\\/]@mantou[\\/]tap-ui[\\/]elements[\\/]code-block\.js$/.test(filename),
      use: [{ loader: new URL('./loaders/prism-local.mjs', import.meta.url).pathname }],
    });
    // @gem-bind/diff2html 的样式改为本地 vendor，见 loaders/diff2html-local.mjs
    config.module.rules.unshift({
      test: /\.js$/,
      include: (filename) => /[\\/]@gem-bind[\\/]diff2html[\\/]dist[\\/]index\.js$/.test(filename),
      use: [{ loader: new URL('./loaders/diff2html-local.mjs', import.meta.url).pathname }],
    });
    config.module.rules.unshift({
      test: /\.js$/,
      enforce: 'pre',
      include: (filename) => !filename.includes('node_modules'),
      use: [
        {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              target: 'es2024',
              parser: { syntax: 'typescript', decorators: true, explicitResourceManagement: true },
              transform: { decoratorVersion: '2023-11' },
              externalHelpers: true,
              experimental: {
                plugins: [
                  [
                    'swc-plugin-gem',
                    {
                      styleMinify: true,
                      selectorCompatible: true,
                      autoImport: {
                        extends: 'gem',
                        elements: {
                          'pages/elements': {
                            'agent-*': '/*',
                          },
                        },
                      },
                      autoImportDts: 'auto-import.d.ts',
                    },
                  ],
                ],
              },
            },
          },
        },
      ],
    });
    return config;
  },
};
