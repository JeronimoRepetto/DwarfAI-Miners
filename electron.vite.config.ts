import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [
      // `exclude` keeps `@modelcontextprotocol/sdk` and `zod` OUT of the
      // externalized-deps list, so Rollup bundles them straight into
      // whichever entry actually imports them — only `jevMcpServer.ts`
      // (#511 T2) does. `index.js`'s own graph never imports either
      // package, so this changes nothing about it: the two stay external
      // for every OTHER dependency, same as before this entry existed.
      // See jevMcpServer.ts's own module comment for why that script needs
      // to be self-contained at all.
      externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk', 'zod'] })
    ],
    build: {
      rollupOptions: {
        // A second entry alongside the app itself (#511 T2): electron-vite's
        // `main` build has no `isolatedEntries` option (that mixin exists
        // only on the preload/renderer build types — checked against the
        // installed electron-vite 5.0.0's own `dist/index.d.ts`), so this
        // relies on ordinary Rollup chunking instead. That is sufficient
        // here specifically because `jevMcpServer.ts`'s whole module graph
        // (delegationProtocol.ts, delegationLink.ts, jevMcpServerCore.ts,
        // the MCP SDK, zod) shares NO runtime import with `index.ts`'s own
        // graph — the one place they touch, `TurnOutcome` from
        // `domain/types`, crosses as `import type`, which is erased before
        // Rollup ever sees it — so Rollup never has a module used by both
        // entries to split into a shared chunk, and each output file comes
        // out standalone on its own.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          jevMcpServer: resolve(__dirname, 'src/main/mcp/jevMcpServer.ts')
        },
        output: {
          // Rollup's own multi-entry default already matches this, but it
          // is pinned explicitly: T4's injection adapters spawn this script
          // by its exact path (`out/main/jevMcpServer.js`), so the name is
          // this build's contract, not an implementation detail.
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()]
  }
})
