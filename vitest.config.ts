import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
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
    environment: 'node'
  }
})
