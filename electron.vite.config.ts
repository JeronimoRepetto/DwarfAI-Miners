import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/*
 * AMENDED for ISSUE-332 (was: two #511 notes on the standalone `jevMcpServer` build, its own config and why this
 * build must never empty its outDir before that prebuilt script ran). The legacy delegation server and its
 * `electron.vite.jevMcpServer.config.ts` build are gone with the cut-5 deletion of `src/main/mcp`: the delegation MCP
 * server is the Host relay `out/host/dwarfai-mcp.js`, built by `electron.vite.relay.config.ts` (relayEntry.ts
 * `RELAY_ENTRY_FILE`). `main.build.emptyOutDir` stays `false`, unchanged. The rule #511 found still holds for every
 * other entry: a second `rollupOptions.input` in one build shares one Rollup graph and splits hashed chunks between
 * the entries, so each self-contained entry (Host, relay, viewer) has its own config.
 */
/*
 * AMENDED for ISSUE-056 (was: the `main` target built today's legacy entry
 * `src/main/index.ts` by electron-vite's own convention into `out/main/index.js`):
 * from cut 0 the app's Electron entry is the UI-main composition root
 * `src/ui-main/index.ts` (21 §2 cut 0, "Retired at the end"; 05 §2.3), built
 * here into `out/ui-main/index.js`, which `package.json` `main` names. The
 * legacy entry stays in the tree, unbuilt; today's runtime is reached only
 * through `LegacyRuntimeRoute` (lint R16). It took over the separate
 * `electron.vite.uiMain.config.ts` target that ISSUE-042 added for the E2E
 * harness, so `pnpm dev` and `pnpm build` start the same entry. Its own folder
 * next to `out/preload` and `out/renderer` keeps their relative paths.
 *
 * `__DWARFAI_BUILD_ID__` stamps the build's git commit, short (20 §3.1
 * `buildId`), which HostClient sends in `hello.client` (ADR-003 item 5), as
 * electron.vite.host.config.ts does for the Host's `hello.ok`. A build made
 * outside a git checkout says `unknown`.
 */
function gitShortCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'unknown'
  }
}

/*
 * ADDED for ISSUE-285 (17 §1.9): the build profile, `DWARFAI_BUILD_PROFILE` at build time, stamped into UI main and
 * the renderer as `__DWARFAI_BUILD_PROFILE__`; both read the one built-modes list from it (`builtModesOf` in
 * src/contracts/ipc/builtModes.ts). Unset is `release`: the Panel alone. The CI E2E and perf lanes build with `e2e`,
 * which adds Veta and Valle. Nothing else selects a mode: no production test backdoor.
 */
const BUILD_PROFILE = JSON.stringify(process.env.DWARFAI_BUILD_PROFILE ?? 'release')

// `@dwarfai/contracts` is the one contracts barrel (ADR-004 P13, 05 §2.1), resolved the same way
// in every build and in both tsconfigs and vitest.config.ts.
export default defineConfig({
  main: {
    resolve: {
      alias: { '@dwarfai/contracts': resolve(__dirname, 'src/contracts/index.ts') }
    },
    plugins: [externalizeDepsPlugin()],
    define: {
      __DWARFAI_BUILD_ID__: JSON.stringify(gitShortCommit()),
      __DWARFAI_BUILD_PROFILE__: BUILD_PROFILE
    },
    build: {
      outDir: 'out/ui-main',
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/ui-main/index.ts') }
      }
    }
  },
  // The preload is one CommonJS script, `out/preload/index.cjs`, whose only runtime import is `electron`: a
  // sandboxed renderer does not load an ES-module preload and cannot require a sibling chunk (S-019-1 Decision;
  // ADR-019 item 1; ISSUE-045). The package is `"type": "module"`, so the format and the `.cjs` name are set here.
  preload: {
    resolve: {
      alias: { '@dwarfai/contracts': resolve(__dirname, 'src/contracts/index.ts') }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { '@dwarfai/contracts': resolve(__dirname, 'src/contracts/index.ts') }
    },
    plugins: [vue()],
    define: { __DWARFAI_BUILD_PROFILE__: BUILD_PROFILE }
  }
})
