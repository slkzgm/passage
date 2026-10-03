import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:5175', launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5175',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
    // A deliberately nonfunctional ID: local injected-wallet tests mock the
    // public directory. This is not a WalletConnect relay integration test.
    env: { VITE_REOWN_PROJECT_ID: '00000000000000000000000000000000' },
  },
})
