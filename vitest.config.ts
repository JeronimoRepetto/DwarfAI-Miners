import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['src/**/*.test.ts'],
    // Node by default (main-process tests); component tests opt into jsdom
    // with a `@vitest-environment jsdom` docblock.
    environment: 'node'
  }
})
