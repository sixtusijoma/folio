import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 150_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 430, height: 900 },
    baseURL: 'http://localhost:43921',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: 'CI=1 EXPO_NO_TELEMETRY=1 npx expo start --web --port 43921 --host localhost',
    url: 'http://localhost:43921',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
