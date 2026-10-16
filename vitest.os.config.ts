import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { windowsCiTestTimeout } from './vitest.config.ts'

// The OS lane, L8 (testing strategy 17 §1.8): `pnpm test:os` runs only the `*.os.test.*` files,
// which the default config excludes. Each one guards itself with
// `describe.runIf(process.platform === ...)`, so a leg runs its own platform's tests and reports
// the others as skipped. CI runs it on Windows, macOS and Linux on every pull request and push
// (17 §1.13), then `scripts/checks/os-lane-guard.mjs` reads the JSON report written below and
// fails the job when zero tests executed (HO-38). The spike harnesses 17 §4 keeps as regression
// tests live under `spikes/`, the packaged OS checks under `scripts/`, the stub-CLI kit's
// real-process cases under `fixtures/bin/_kit/`.
export default defineConfig({
  resolve: {
    // The one contracts barrel (ADR-004 P13), same alias as vitest.config.ts and both tsconfigs.
    alias: {
      '@dwarfai/contracts': fileURLToPath(new URL('./src/contracts/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['{src,spikes,scripts,fixtures}/**/*.os.test.{ts,mjs}'],
    // `__fixtures__/` holds test-shaped data of other tests (the trace extractor's sample repo, 17
    // §2.2), never an OS-lane test.
    exclude: [...configDefaults.exclude, '**/__fixtures__/**'],
    environment: 'node',
    // The Windows CI runner's per-test timeout, the policy vitest.config.ts documents: its disk and
    // process table stall for seconds now and then, and OS-lane tests do real I/O and start real
    // processes on it. Every other run keeps vitest's 5 000 ms default.
    ...windowsCiTestTimeout,
    // The run's template database (17 §1.5 "Speed"; 09 §6.5), as in vitest.config.ts: an OS-lane
    // test that needs the Host database copies it (`templateDb.ts`) instead of migrating a file of
    // its own, whose migration and checkpoint flush outlasted the per-test timeout on Windows CI.
    globalSetup: ['src/host/platform/sqlite/testing/templateDb.globalSetup.ts'],
    // `default` keeps the console output; `json` is the executed-test count the guard reads. The
    // path matches OS_LANE_REPORT in scripts/checks/os-lane-guard.mjs (git-ignored `coverage/`).
    reporters: ['default', 'json'],
    outputFile: { json: 'coverage/os-lane/report.json' }
  }
})
