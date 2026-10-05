import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { configDefaults, defineConfig } from 'vitest/config'

// The per-test timeout on the Windows CI runner. Measured on the Windows leg's `Test (L1-L7)`
// step (38 runs with a test log among the last 60, 2026-10-01/02, plus the failed runs among the
// last 100): the runner's disk and process table stall for a few seconds now and then, and any
// test that touches real files or starts a process pays for it. In seven failures across six
// runs, tests whose median on that leg is at most 1.6 s took 5.1-7.6 s and exceeded vitest's
// 5 000 ms default, in four trees: src/host/platform/sqlite (backup, quarantine),
// src/ui-main/diagnostics (uiLogger), fixtures/bin/_kit (stubCli) and scripts/checks
// (contract-sync). The in-memory tests running beside them stayed in milliseconds, and the Linux
// and macOS legs had no such timeout. Defender's real-time scan is off on GitHub's Windows
// runners. So the class is "real I/O on that runner", not a list of files or folders: a per-file
// or per-path timeout would only move to the next file that stalls. On that runner a test gets
// 30 s, four times the worst stall seen; it stays a hang detector, never a speed check (a speed
// budget belongs to the perf lane, 17 §1.11). Every other run keeps vitest's 5 000 ms default,
// and tests that are slow by design keep their own timeout. GitHub Actions sets CI=true.
const WINDOWS_CI_TEST_TIMEOUT_MS = 30_000
const onWindowsCi = process.platform === 'win32' && process.env['CI'] === 'true'

/**
 * electron-vite's `?modulePath` import (a worker thread's entry, bundled as its own chunk by the
 * build; FsSourceWeightScanner's scan worker, ISSUE-065) has no meaning to vitest, which would
 * import the module itself instead. Here it answers the entry's own source path, and the test's
 * real worker thread runs that TypeScript file with Node's type stripping, so a worker entry and
 * what it imports use `.ts` specifiers and erasable syntax only.
 */
function workerModulePath(): Plugin {
  const SUFFIX = '?modulePath'
  const PREFIX = '\0dwarfai-module-path:'
  return {
    name: 'dwarfai:module-path',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith(SUFFIX)) return null
      const resolved = await this.resolve(id.slice(0, -SUFFIX.length), importer, {
        skipSelf: true
      })
      return resolved === null ? null : PREFIX + resolved.id
    },
    load(id) {
      return id.startsWith(PREFIX)
        ? `export default ${JSON.stringify(id.slice(PREFIX.length))}`
        : null
    }
  }
}

export default defineConfig({
  plugins: [vue(), workerModulePath()],
  resolve: {
    // The one contracts barrel (ADR-004 P13), same alias as both tsconfigs and electron-vite.
    alias: {
      '@dwarfai/contracts': fileURLToPath(new URL('./src/contracts/index.ts', import.meta.url))
    }
  },
  test: {
    // Renderer/main code is TypeScript under src/; the art pipeline is plain
    // ESM under scripts/ because it runs straight from node with no build step.
    // The perf runner's own L7 test lives beside it under perf/_harness/ (17 §1.11);
    // the perf cases themselves (`*.perf.ts`) run only through `pnpm test:perf`.
    // The stub-CLI kit's own L7 test lives beside its engine under fixtures/bin/_kit/ (17 §1.9).
    include: [
      'src/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'perf/**/*.test.mjs',
      'fixtures/**/*.test.mjs'
    ],
    // Golden UI tests need the private design repository and a real browser: they run only
    // through `pnpm test:golden` (vitest.golden.config.ts), never here or on CI (#634).
    // OS-lane tests need a real OS facility of one platform: they run only through
    // `pnpm test:os` (vitest.os.config.ts), so `pnpm test` stays runnable on any machine (17 §1.8).
    exclude: [...configDefaults.exclude, '**/*.golden.test.*', '**/*.os.test.*'],
    // Node by default (main-process tests); component tests opt into jsdom
    // with a `@vitest-environment jsdom` docblock.
    environment: 'node',
    ...(onWindowsCi ? { testTimeout: WINDOWS_CI_TEST_TIMEOUT_MS } : {}),
    // The Host database template (17 §1.5 "Speed"; 09 §6.5 "Template DB"): migrated once per run,
    // copied by each database test through `copyTemplateDb()` / `openTemplateCopy()`.
    globalSetup: ['src/host/platform/sqlite/testing/templateDb.globalSetup.ts']
  }
})
