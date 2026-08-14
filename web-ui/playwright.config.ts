import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.PHILONT_E2E_BASE_URL ?? 'http://127.0.0.1:20267',
    // GitHub's macOS image ships Chrome. Using its installed browser keeps this
    // platform smoke independent of a second Playwright browser download.
    channel: process.env.CI ? 'chrome' : undefined,
    headless: true,
    trace: 'retain-on-failure',
  },
});
