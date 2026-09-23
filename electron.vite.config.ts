import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/*
 * AMENDED for #511 M1a/L2 (was: `jevMcpServer` a SECOND `rollupOptions.input`
 * entry in this SAME `main` build, sharing one Rollup module graph with
 * `index`). #511 M1a gave `index.ts`'s own graph a genuine runtime need for
 * `zod` too (`delegationHeldServer.ts`'s in-process SDK tools, via the Agent
 * SDK's own `tool()`), so the two entries no longer share NO runtime
 * import — the premise this file's own comment used to state for why one
 * shared Rollup graph was safe. Once `zod` is excluded from externalization
 * (needed so it bundles fully into `jevMcpServer.mjs`, never resolved via
 * `node_modules` from its own unpacked, plain-Node location) and is ALSO
 * reachable from `index`'s own graph, Rollup's ordinary multi-entry
 * chunking extracts the shared portion into `out/main/chunks/*.js` —
 * observed directly: `pnpm build` grew exactly that chunk, imported by BOTH
 * `index.js` and `jevMcpServer.mjs`, once `delegationHeldServer.ts` started
 * importing `zod`. That breaks the same self-containment promise this file
 * already protects for `delegationProtocol.ts` (see
 * `delegationServerProtocol.ts`'s own top comment) — a plain-Node process
 * spawned at `jevMcpServer.mjs`'s own unpacked location has no guaranteed
 * way to resolve a SIBLING chunk file either, for the identical
 * `ELECTRON_RUN_AS_NODE`-reading-outside-node_modules reason.
 *
 * `jevMcpServer.ts` now builds as its OWN, wholly separate electron-vite
 * invocation (`electron.vite.jevMcpServer.config.ts`) — a genuinely
 * independent Rollup graph, so nothing it needs can ever be extracted into a
 * chunk shared with `index.js`, regardless of what either graph imports in
 * the future. `pnpm build` runs both (see `package.json`'s own `build`
 * script); `jevMcpServer.ts`'s own module comment and that config's own
 * comment carry the rest of the reasoning.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()]
  }
})
