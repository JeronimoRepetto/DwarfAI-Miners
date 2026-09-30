import { defineConfig } from '@playwright/test'

/**
 * The E2E lane, L9: `pnpm test:e2e` (testing strategy `17` §1.9, §1.13, §5.4; `docs/e2e.md`).
 *
 * Each case launches the **built** app (`pnpm build`, the `electron-vite build` output in `out/`)
 * through `e2e/_harness/launchApp.ts` with Playwright's `_electron`, under an isolated profile. CI
 * runs it as a release lane on Windows, macOS and Linux (Xvfb), never as a merge check (HO-38).
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // One app at a time per OS job: cases share the machine's display, focus and tray.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  // L9 allows at most one retry, and a test that passed only on retry is reported as flaky
  // (17 §5.4); the harness self-test sets its own retries to zero.
  retries: 1,
  timeout: 60_000,
  // Each case saves its trace (launchApp `tracePath`) into its output folder; only a failed
  // case's folder is kept, so traces stay on failure only.
  outputDir: 'test-results/e2e',
  preserveOutput: 'failures-only',
  reporter: process.env.CI ? [['list'], ['github']] : 'list'
})
