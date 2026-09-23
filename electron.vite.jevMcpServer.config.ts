import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * The standalone stdio MCP server script (#511 T2), built as its OWN,
 * wholly separate electron-vite invocation rather than a second entry
 * inside `electron.vite.config.ts`'s own `main` build (#511 M1a/L2 — see
 * that file's own top comment for why one shared Rollup graph stopped being
 * safe: `zod` became a genuine runtime dependency of BOTH `index.ts`'s own
 * graph, via `delegationHeldServer.ts`'s in-process SDK tools, and this
 * one). Run as a second step in `package.json`'s `build` script, into the
 * SAME `out/main/` directory `electron-vite build` already populated —
 * `emptyOutDir: false` is load-bearing: without it Vite's own safety default
 * (empty a resolved outDir that sits inside the project root) would delete
 * `index.js` and everything else the first build step just wrote.
 *
 * `externalizeDepsPlugin({ exclude: [...] })` here — a FRESH instance,
 * scoped to only THIS build's own module graph — is what makes
 * `@modelcontextprotocol/sdk` and `zod` bundle straight into this one
 * output file rather than being left as `node_modules`-resolved imports:
 * this script runs as `process.execPath <script>` from wherever it was
 * unpacked to (`app.asar.unpacked/` in a packaged build), a location with
 * no measured guarantee that a plain Node process under
 * `ELECTRON_RUN_AS_NODE` can resolve `node_modules` from — see
 * `jevMcpServer.ts`'s and `delegationServerCommand.ts`'s own comments for
 * the full reasoning. Because this is now a TRULY SEPARATE Rollup
 * invocation with its own module graph, nothing it bundles can ever be
 * extracted into a chunk shared with `index.js`'s build, regardless of what
 * either side imports later — the property `pnpm build`'s own verification
 * checks for (`out/main/jevMcpServer.mjs` importing nothing but
 * `node:process`, no `out/main/chunks/` directory at all).
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk', 'zod'] })],
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          jevMcpServer: resolve(__dirname, 'src/main/mcp/jevMcpServer.ts')
        },
        output: {
          // `.mjs`, not `.js` (#511 L2): see `delegationServerCommand.ts`'s
          // own comment on the ESM-vs-CommonJS syntax-detection failure this
          // avoids for a script unpacked outside this app's own
          // `package.json`.
          entryFileNames: 'jevMcpServer.mjs'
        }
      }
    }
  }
})
