import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

/**
 * Builds the Control-room scaling page (ISSUE-298, S-034-1) with Vite, in production mode, into
 * `out/perf/controlRoom/` (git-ignored), and answers the built `index.html`. Its own build with no
 * config file, as the golden page's server is, so electron-vite never learns the page exists and
 * no production entry can reach it (R13). The renderer's own alias and build-profile constant are
 * set as electron.vite.config.ts sets them.
 */
export async function buildControlRoomPage(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..', '..', '..')
  const outDir = path.join(root, 'out', 'perf', 'controlRoom')
  await build({
    configFile: false,
    root: here,
    base: './',
    mode: 'production',
    logLevel: 'warn',
    plugins: [vue()],
    resolve: {
      alias: { '@dwarfai/contracts': path.join(root, 'src', 'contracts', 'index.ts') }
    },
    define: { __DWARFAI_BUILD_PROFILE__: JSON.stringify('e2e') },
    build: { outDir, emptyOutDir: true }
  })
  return path.join(outDir, 'index.html')
}
