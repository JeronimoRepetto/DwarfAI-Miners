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
 *
 * AMENDED for #511 T5: `main.build.emptyOutDir` is now explicitly `false`.
 * electron-vite's own `main` preset
 * (`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:292-301`,
 * `electronMainConfigPresetPlugin`) sets `build.outDir` but never sets
 * `build.emptyOutDir`, so it fell through to Vite's own default — `null`
 * (`node_modules/vite/dist/node/chunks/config.js:33444`), resolved to `true`
 * whenever `outDir` sits inside the project root
 * (`config.js:16759-16766`, `resolveEmptyOutDir`) — and Vite's build then
 * empties the WHOLE directory once, before writing anything
 * (`config.js:33401-33409`, `prepareOutDir`/`emptyDir`; gated to run exactly
 * once per build via `prepareOutDirPlugin`'s own `rendered` set,
 * `config.js:33379-33399`, so a `-w` watch rebuild does not repeat it).
 * `electron-vite dev` (`package.json`'s own `dev` script) runs precisely that
 * one-shot `main` build through `doBuild`
 * (`node_modules/electron-vite/dist/chunks/lib-7y7CgM8M.js:36` calling
 * `build(config)` at `:100`) BEFORE Electron is ever started — which used to
 * empty `out/main` first and only ever write `index.js` into it, silently
 * deleting an already-built `jevMcpServer.mjs` the instant `pnpm dev` ran
 * (`jevMcpServer.ts` is not part of THIS config's own entry at all; see
 * `electron.vite.jevMcpServer.config.ts`, a wholly separate build). `false`
 * here is the other half of the fix, alongside `package.json`'s new
 * `build:mcp-server` step running BEFORE `electron-vite dev`: without it,
 * that prebuilt script would simply be wiped the moment `dev` started its
 * own main build. `pnpm build`'s own first step is unaffected in practice —
 * `main`'s only output is the single `index.js` lib entry (no hashed asset
 * chunks observed; verified with `out/main/index.js` + `jevMcpServer.mjs`,
 * no `out/main/chunks/`), so there is nothing this build ever produced that
 * skipping the empty step could leave stale.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      emptyOutDir: false
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()]
  }
})
