import { defineConfig } from '@playwright/test';

// A Chrome extension's service worker and `chrome.alarms` only exist in a real browser, so
// this suite loads the actual unpacked build (see tests/e2e/fixtures.ts) in a headed,
// persistent-context Chromium rather than Playwright's usual `page` fixture -- there is no
// `use.browserName` project list here because every test builds its own context fixture.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One extension profile (one real Chromium process) at a time: these tests drive the
  // browser's own window/tab focus, which is process-wide state and would race if two
  // instances ran side by side.
  workers: 1,
  retries: 0,
  reporter: 'list',
});
