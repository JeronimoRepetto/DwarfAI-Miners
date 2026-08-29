import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    // Renderer/main code is TypeScript under src/; the art pipeline is plain
    // ESM under scripts/ because it runs straight from node with no build step.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Node by default (main-process tests); component tests opt into jsdom
    // with a `@vitest-environment jsdom` docblock.
    environment: 'node'
  }
})
