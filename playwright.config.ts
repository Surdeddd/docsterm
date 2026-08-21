import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:4179',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command:
      'pnpm --filter docsterm-demo run build && pnpm --filter docsterm-demo exec vite preview --host 127.0.0.1 --port 4179',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
