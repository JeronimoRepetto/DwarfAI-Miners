import { configDefaults, defineConfig } from 'vitest/config'

/*
 * The golden UI tests (#634): `pnpm test:golden` only, never `pnpm test`. They drive a real
 * browser against the private design repository's references, so they run on the maintainer's
 * machine alone — `scripts/golden/run.mjs` decides first whether a run may go ahead — one file at
 * a time, since every file drives the same browser build, with timeouts long enough for a browser
 * launch and a Vite server start.
 */
export default defineConfig({
  test: {
    include: ['**/*.golden.test.mjs'],
    exclude: [...configDefaults.exclude, '.design/**'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
