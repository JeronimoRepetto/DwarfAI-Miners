import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../../electron.vite.config'

/**
 * `pnpm build` must emit BOTH `out/main/index.js` (the app) and
 * `out/main/jevMcpServer.js` (the standalone stdio server, #511 T2) from one
 * `main` build — this pins the two-entry declaration that makes that true.
 * `defineConfig` (electron-vite) is the identity function, so importing the
 * config file directly hands back the exact object electron-vite itself
 * would build from, with no Vite instance needed.
 *
 * Whether `@modelcontextprotocol/sdk`/`zod` actually end up BUNDLED into
 * `jevMcpServer.js` rather than externalized is a real build output, not a
 * config shape — that is proven by actually running `pnpm build` and
 * grepping the result (see this task's own verification report), not by a
 * unit test against the plugin's private closure state.
 */
describe('electron.vite.config main build', () => {
  it('declares two rollup entries: the app and the standalone jevMcpServer script', () => {
    const projectRoot = resolve(__dirname, '../../..')
    expect(config.main?.build?.rollupOptions?.input).toEqual({
      index: resolve(projectRoot, 'src/main/index.ts'),
      jevMcpServer: resolve(projectRoot, 'src/main/mcp/jevMcpServer.ts')
    })
  })

  it('names both entry outputs [name].js, so the server keeps a predictable path', () => {
    const output = config.main?.build?.rollupOptions?.output
    const entryFileNames = Array.isArray(output)
      ? output[0]?.entryFileNames
      : output?.entryFileNames
    expect(entryFileNames).toBe('[name].js')
  })
})
