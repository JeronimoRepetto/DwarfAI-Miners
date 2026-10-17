import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/*
 * ADDED for ISSUE-170: the build target of the console viewer (ADR-031 item 2; 16 §8.1 "Console
 * viewer"), `src/host/modules/conversation/adapters/console/viewer/viewerMain.ts`, into
 * `out/host/dwarfai-viewer.js` (viewerEntry.ts VIEWER_ENTRY_FILE). UI main runs it on the same
 * versioned-copy executable as the Host, with ELECTRON_RUN_AS_NODE=1, from the same app directory, so
 * it ships wherever `out/host/main.js` ships (package.json `build.files` takes `out/**`) and needs no
 * packaging change.
 *
 *   electron-vite build --config electron.vite.viewer.config.ts
 *
 * Its own config, like `electron.vite.relay.config.ts` and for the same reason: a second `input` in
 * the Host build shares one Rollup graph between two entries and splits their common code into
 * hashed `out/host/chunks/*.js`, so `out/host/main.js` would stop being one self-contained file. A
 * separate build has its own module graph. `emptyOutDir: false` because the Host build owns the rest
 * of `out/host`.
 *
 * `__DWARFAI_APP_VERSION__` and `__DWARFAI_BUILD_ID__` are stamped as electron.vite.host.config.ts
 * stamps them: the viewer's `hello.client` carries them (ADR-003 item 5), and its one failure line
 * carries the app version (ADR-026 item 3).
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
    plugins: [externalizeDepsPlugin()],
    define: {
      __DWARFAI_APP_VERSION__: JSON.stringify(version),
      __DWARFAI_BUILD_ID__: JSON.stringify(gitShortCommit())
    },
    build: {
      outDir: 'out/host',
      emptyOutDir: false,
      rollupOptions: {
        input: {
          'dwarfai-viewer': resolve(
            __dirname,
            'src/host/modules/conversation/adapters/console/viewer/viewerMain.ts'
          )
        }
      }
    }
  }
})
