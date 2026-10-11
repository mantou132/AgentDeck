import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Main-flow e2e against a real host (the App Store review machine), run by hand with `pnpm test:e2e`.
// Not part of `pnpm test`: it needs the network and a live daemon.
// `E2E_PAIRING_ID` / `E2E_CHROME_PATH` come from the environment or the gitignored `.env.local`.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const chromePath = process.env.E2E_CHROME_PATH;

export default defineConfig({
  testDir: './e2e',
  // The review host is memory-capped, so never run sessions in parallel.
  workers: 1,
  timeout: 5 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:1420',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        // Uses the installed Chrome instead of downloading Playwright's build; override with E2E_CHROME_PATH.
        ...(chromePath ? { launchOptions: { executablePath: chromePath } } : { channel: 'chrome' }),
      },
    },
  ],
  webServer: {
    command: 'pnpm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
  },
});
