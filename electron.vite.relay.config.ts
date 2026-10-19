import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/*
 * ADDED for ISSUE-200: the build target of the delegation MCP relay `dwarfai-mcp` (ADR-013 item 3),
 * `src/host/modules/delegation/adapters/mcp/relay/relayMain.ts`, into `out/host/dwarfai-mcp.js`
 * (relayEntry.ts RELAY_ENTRY_FILE). The relay entry runs it on the same versioned-copy executable
 * as the Host, with ELECTRON_RUN_AS_NODE=1, from the same app directory, so it ships wherever
 * `out/host/main.js` ships and needs no packaging change. Its name is the relay's name in ADR-013.
 *
 *   electron-vite build --config electron.vite.relay.config.ts
 *
 * Its own config, like `electron.vite.host.config.ts`
 * and for the same reason: a second `input` in the Host build shares one Rollup graph between two
 * entries and splits their common code into hashed `out/host/chunks/*.js`, so `out/host/main.js`
 * stops being one self-contained file and imports a chunk shared with the relay. A separate build
 * has its own module graph, so nothing the relay bundles is ever shared with the Host entry.
 * `emptyOutDir: false` because the Host build owns the rest of `out/host`.
 *
 * The `@dwarfai/contracts` alias is the Host build's: Host code the relay bundles imports the barrel.
 * The relay reads neither `__DWARFAI_APP_VERSION__` nor `__DWARFAI_BUILD_ID__`, so this build
 * defines neither.
 */
export default defineConfig({
  main: {
    resolve: {
      alias: { '@dwarfai/contracts': resolve(__dirname, 'src/contracts/index.ts') }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/host',
      emptyOutDir: false,
      rollupOptions: {
        input: {
          'dwarfai-mcp': resolve(
            __dirname,
            'src/host/modules/delegation/adapters/mcp/relay/relayMain.ts'
          )
        }
      }
    }
  }
})
