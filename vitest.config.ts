import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    // Renderer/main code is TypeScript under src/; the art pipeline is plain
    // ESM under scripts/ because it runs straight from node with no build step.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Golden UI tests need the private design repository and a real browser: they run only
    // through `pnpm test:golden` (vitest.golden.config.ts), never here or on CI (#634).
    exclude: [...configDefaults.exclude, '**/*.golden.test.*'],
    // Node by default (main-process tests); component tests opt into jsdom
    // with a `@vitest-environment jsdom` docblock.
    environment: 'node'
  }
})
