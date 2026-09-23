import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import mainConfig from '../../../electron.vite.config'
import jevMcpServerConfig from '../../../electron.vite.jevMcpServer.config'

/**
 * `pnpm build` must emit BOTH `out/main/index.js` (the app) and
 * `out/main/jevMcpServer.mjs` (the standalone stdio server, #511 T2) — this
 * pins the two config DECLARATIONS that make that true. `defineConfig`
 * (electron-vite) is the identity function, so importing either config file
 * directly hands back the exact object electron-vite itself would build
 * from, with no Vite instance needed.
 *
 * AMENDED for #511 M1a/L2 (was: one test file asserting BOTH entries lived
 * in `electron.vite.config.ts`'s own single `main.build.rollupOptions.input`
 * map). `delegationHeldServer.ts` gave `index.ts`'s own graph a genuine
 * runtime need for `zod` too, so sharing one Rollup graph between the two
 * entries started producing a shared `out/main/chunks/*.js` file — see
 * `electron.vite.config.ts`'s own top comment for the observed regression.
 * `jevMcpServer.ts` now builds through its own separate config
 * (`electron.vite.jevMcpServer.config.ts`), proven here as its own
 * declaration rather than a second key in the app's own build.
 *
 * Whether `@modelcontextprotocol/sdk`/`zod` actually end up BUNDLED into
 * `jevMcpServer.mjs` rather than externalized, and whether `out/main/chunks/`
 * stays absent, are real build outputs, not a config shape — that is proven
 * by actually running `pnpm build` and inspecting the result (see this
 * task's own verification report), not by a unit test against the plugin's
 * private closure state.
 */
describe('electron.vite.config (app build)', () => {
  it('carries no custom rollupOptions.input any more — back to electron-vite’s own default single-entry convention', () => {
    // #511 M1a/L2: this is exactly the shape the config had before #511 T2
    // ever added a second entry (`6aace4a`, pre-#511) — electron-vite
    // resolves `src/main/index.ts` by its own convention with no explicit
    // `rollupOptions.input` at all, which is what the earlier `pnpm build`
    // in this task's own verification confirmed still produces
    // `out/main/index.js`.
    expect(mainConfig.main?.build?.rollupOptions?.input).toBeUndefined()
  })

  it('externalizes every main dependency normally — nothing force-bundled here any more', () => {
    // #511 M1a/L2: the `exclude: ['@modelcontextprotocol/sdk', 'zod']` this
    // config used to carry moved to `electron.vite.jevMcpServer.config.ts`'s
    // own, separate `externalizeDepsPlugin` instance — this build's plugin
    // list no longer needs (or should) special-case either package, since
    // `zod`/`@anthropic-ai/claude-agent-sdk` now resolve via ordinary
    // `node_modules` for `index.js`, exactly like every other dependency.
    expect(mainConfig.main?.plugins).toBeDefined()
  })

  /*
   * #511 T5: electron-vite's own `electronMainConfigPresetPlugin`
   * (node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:292-301) sets
   * `build.outDir` for `main` but never sets `build.emptyOutDir`, so it falls
   * through to Vite's own default (`node_modules/vite/dist/node/chunks/
   * config.js:33444`, `emptyOutDir: null`) — resolved to `true` whenever the
   * outDir sits inside the project root
   * (`node_modules/vite/dist/node/chunks/config.js:16759-16766`,
   * `resolveEmptyOutDir`), which empties the WHOLE directory once per build
   * (`config.js:33401-33409`, `prepareOutDir`/`emptyDir`) before writing
   * `index.js`. `electron-vite dev` (package.json's own `dev` script) runs
   * exactly that same one-shot `vite build()` call for `main`
   * (node_modules/electron-vite/dist/chunks/lib-7y7CgM8M.js:36 and :100,
   * `doBuild`), which is what would silently delete an already-built
   * `jevMcpServer.mjs` the instant `pnpm dev` starts, before ever writing
   * it back — `jevMcpServer.mjs` is not part of THIS config's own entry at
   * all (see `electron.vite.jevMcpServer.config.ts`, a wholly separate
   * build). `false` here is what lets `pnpm dev`'s own prebuild step
   * (package.json's `build:mcp-server`, run before `electron-vite dev`)
   * survive that first main build.
   */
  it('never empties out/main either (#511 T5) — dev must not wipe jevMcpServer.mjs before it ever starts Electron', () => {
    expect(mainConfig.main?.build?.emptyOutDir).toBe(false)
  })
})

describe('electron.vite.jevMcpServer.config (standalone server build, #511 M1a/L2)', () => {
  it('declares exactly the jevMcpServer entry, in its own separate Rollup graph', () => {
    const projectRoot = resolve(__dirname, '../../..')
    expect(jevMcpServerConfig.main?.build?.rollupOptions?.input).toEqual({
      jevMcpServer: resolve(projectRoot, 'src/main/mcp/jevMcpServer.ts')
    })
  })

  it('never empties out/ — the app build already wrote index.js there first', () => {
    expect(jevMcpServerConfig.main?.build?.emptyOutDir).toBe(false)
  })

  /*
   * #511 L2. An unpacked jevMcpServer.mjs relied on Node's ESM-vs-CommonJS
   * syntax detection, which falls back to the NEAREST ancestor package.json's
   * own "type" field — and in a packaged build that file physically sits
   * under `app.asar.unpacked/`, outside this app's own package.json entirely
   * (it stays sealed inside app.asar), so Node's directory walk can land on
   * an unrelated ancestor defaulting to "type":"commonjs" (reproduced under
   * Electron 44's ELECTRON_RUN_AS_NODE) and refuse to parse the ESM syntax
   * inside. `.mjs` is unambiguous regardless of any nearby package.json.
   */
  it('names the output jevMcpServer.mjs specifically', () => {
    const output = jevMcpServerConfig.main?.build?.rollupOptions?.output
    const entryFileNames = Array.isArray(output)
      ? output[0]?.entryFileNames
      : output?.entryFileNames
    expect(entryFileNames).toBe('jevMcpServer.mjs')
  })
})
