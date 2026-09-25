import { defineConfig, devices } from '@playwright/test';

// 本地直接运行时自动拉起 Vite 预览；
// 在 Docker verify 容器中（CI=1）由 npm run preview 预先启动并复用。
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry'
  },
  webServer: isCI
    ? undefined
    : {
        command: 'npm run preview',
        port: 4173,
        reuseExistingServer: true,
        timeout: 60_000
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
