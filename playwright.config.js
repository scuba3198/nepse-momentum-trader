import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/nepse-momentum-trader/',
    reuseExistingServer: false,
    timeout: 120000,
  },
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173/nepse-momentum-trader/', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173/nepse-momentum-trader/' } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], baseURL: 'http://127.0.0.1:4173/nepse-momentum-trader/' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], baseURL: 'http://127.0.0.1:4173/nepse-momentum-trader/' } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'], baseURL: 'http://127.0.0.1:4173/nepse-momentum-trader/' } },
  ],
})
