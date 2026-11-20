import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 70_000,
  use: {
    baseURL: 'http://localhost:5173/Blackjack/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: 'node tests/browser-server.mjs',
    url: 'http://localhost:5173/Blackjack/',
    timeout: 35_000,
    reuseExistingServer: false,
  },
})
