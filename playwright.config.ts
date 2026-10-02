import { defineConfig } from '@playwright/test'

/**
 * The E2E lane, L9: `pnpm test:e2e` (testing strategy `17` §1.9, §1.13, §5.4; `docs/e2e.md`).
 *
 * Each case launches the **built** app (`pnpm build`, the `electron-vite build` output in `out/`)
 * through `e2e/_harness/launchApp.ts` with Playwright's `_electron`, under an isolated profile. CI
 * runs it as a release lane on Windows, macOS and Linux (Xvfb), never as a merge check (HO-38).
 */
export default defineConfig({
  // The E2E cases, plus the spike harnesses 17 §4 keeps as E2E cases (S-019-1: drag-and-drop under the sandbox).
  testDir: '.',
  testMatch: ['e2e/**/*.e2e.ts', 'spikes/**/*.e2e.ts'],
  // `__fixtures__/` holds test-shaped data of other tests (the trace extractor's sample repo, 17 §2.2).
  testIgnore: ['**/node_modules/**', '**/__fixtures__/**'],
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
  // The run fails when a case left a `dwarfai-e2e-*` temp folder behind (the leftover is removed first; ISSUE-056).
  globalSetup: './e2e/_harness/globalSetup.ts',
  globalTeardown: './e2e/_harness/globalTeardown.ts',
  preserveOutput: 'failures-only',
  reporter: process.env.CI ? [['list'], ['github']] : 'list'
})
