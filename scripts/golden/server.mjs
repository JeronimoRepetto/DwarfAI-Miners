/*
 * A Vite dev server over the renderer, serving `src/renderer/golden.html`: the page the golden
 * UI tests (#634) stage a state in. It is its own server with no config file, so the product's
 * build (electron-vite, whose renderer input is `index.html` alone) never learns the page exists.
 *
 * Loopback only, on a port the OS picks, with no file watcher and no hot reload: a golden run
 * reads the tree once. Vite's dependency cache goes to the golden temp directory, so a run never
 * touches the cache `pnpm dev` uses.
 */
import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import { outputDir } from './compare.mjs'

export async function startGoldenServer(checkout) {
  const server = await createServer({
    configFile: false,
    root: path.join(checkout, 'src', 'renderer'),
    plugins: [vue()],
    appType: 'mpa',
    logLevel: 'error',
    clearScreen: false,
    cacheDir: path.join(outputDir(), 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }
  })
  await server.listen()
  const address = server.httpServer.address()
  return {
    url: 'http://127.0.0.1:' + address.port + '/golden.html',
    close: () => server.close()
  }
}
