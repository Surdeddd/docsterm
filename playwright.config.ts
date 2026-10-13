import { defineConfig } from '@playwright/test'

const PORT = 4179
const CI = Boolean(process.env.CI)

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    locale: 'en-US',
    colorScheme: 'light',
    trace: CI ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: [
      'pnpm --filter docsterm run build',
      'pnpm --filter docsterm-demo run build',
      `pnpm --filter docsterm-demo exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    ].join(' && '),
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
})
