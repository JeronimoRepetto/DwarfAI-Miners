import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/*
 * ADDED for ISSUE-042: the build target of the new Electron composition root,
 * `src/ui-main/index.ts` (05 §2.3), into `out/ui-main/index.js`. It is not
 * the app entry yet: `pnpm build` (electron.vite.config.ts) still builds
 * `src/main/index.ts` into `out/main/index.js`, byte for byte as before, and
 * ISSUE-056 switches the entry. Until then this target is what the E2E
 * harness launches with `entry: 'ui-main'` (ISSUE-051 is the first case):
 *
 *   electron-vite build --config electron.vite.uiMain.config.ts
 *
 * after `pnpm build`, which writes the `out/preload` and `out/renderer` this
 * entry loads.
 *
 * Its own config, like `electron.vite.jevMcpServer.config.ts` and for the same
 * reason: a second `input` in the app's own `main` build would share today's
 * whole runtime between two entries, and Rollup would split `index.js` into
 * hashed `out/main/chunks/*` that `emptyOutDir: false` would then leave behind
 * build after build (see electron.vite.config.ts's own top comment). Its own
 * folder next to `out/preload` and `out/renderer`, so the legacy window's
 * `../preload/index.cjs` and `../renderer/index.html` (src/main/shell/window.ts)
 * resolve from it exactly as from `out/main`. `emptyOutDir: false` because
 * this build writes only `out/ui-main/index.js` and never owns the folder's
 * other files. Only `main` is built: preload and renderer are the app's own.
 *
 * ADDED for ISSUE-051: `__DWARFAI_BUILD_ID__` stamps the build's git commit,
 * short (20 §3.1 `buildId`), which HostClient sends in `hello.client` (ADR-003
 * item 5), as electron.vite.host.config.ts does for the Host's `hello.ok`. A
 * build made outside a git checkout says `unknown`.
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

export default defineConfig({
  main: {
    resolve: {
      alias: { '@dwarfai/contracts': resolve(__dirname, 'src/contracts/index.ts') }
    },
    plugins: [externalizeDepsPlugin()],
    define: {
      __DWARFAI_BUILD_ID__: JSON.stringify(gitShortCommit())
    },
    build: {
      outDir: 'out/ui-main',
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/ui-main/index.ts') }
      }
    }
  }
})
