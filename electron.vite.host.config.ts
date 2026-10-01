import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/*
 * ADDED for ISSUE-021: the build target of the DwarfAI Host's composition root,
 * `src/host/main.ts` (05 §2.3, 16 §8.1), into `out/host/main.js`. The Host runs
 * that file on the app's own executable with ELECTRON_RUN_AS_NODE=1 (ADR-002
 * D1; SP-04 kept that runtime), so it is a plain Node entry and imports no
 * `electron` (R7). Nothing spawns it yet: the UI's Host launcher (ISSUE-030)
 * starts it, and the UI never imports it (R10).
 *
 *   electron-vite build --config electron.vite.host.config.ts
 *
 * Its own config, like `electron.vite.jevMcpServer.config.ts` and for the same
 * reason: a second `input` in the app's own `main` build would share one Rollup
 * graph between two entries and split hashed chunks into `out/main` (see
 * electron.vite.config.ts's own top comment). Its own folder, `out/host`, and
 * `emptyOutDir: false` because the other builds own the rest of `out/`.
 *
 * `__DWARFAI_APP_VERSION__` stamps package.json's version into the bundle: the
 * Host has no Electron `app.getVersion()` (ADR-002 D1), and every log record
 * carries the app version (ADR-026 item 3).
 *
 * ADDED for ISSUE-023: `__DWARFAI_BUILD_ID__` stamps the build's git commit,
 * short (20 §3.1 `buildId`), which the Host sends in `hello.ok` (ADR-003 item
 * 5). A build made outside a git checkout has no commit to name and says
 * `unknown`.
 */
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

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
      __DWARFAI_APP_VERSION__: JSON.stringify(version),
      __DWARFAI_BUILD_ID__: JSON.stringify(gitShortCommit())
    },
    build: {
      outDir: 'out/host',
      emptyOutDir: false,
      rollupOptions: {
        input: { main: resolve(__dirname, 'src/host/main.ts') }
      }
    }
  }
})
