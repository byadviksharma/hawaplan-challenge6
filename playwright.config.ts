import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'e2e',
  workers: 2,
  timeout: 35_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  use: {
    baseURL: process.env.HAWAPLAN_TEST_URL ?? 'http://127.0.0.1:4173',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    ...[390, 320].map((width) => ({
      name: width === 390 ? 'phone' : 'narrow',
      use: {
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    })),
  ],
  webServer: process.env.HAWAPLAN_TEST_URL
    ? undefined
    : {
        command: 'npm run preview -- --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
      },
})
