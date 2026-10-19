// The electron-vite plugin behind the cut-0 rollback rehearsal's second build (ISSUE-057; 21 §2.1 item 1; ADR-002 D8;
// `e2e/cut-0/rollback-rehearsal.e2e.ts`).
//
// A rollback build differs from the faulty build in its app version (a new versioned copy, ADR-002 D5) and in its
// `protocolVersion`: with an equal one D8 item 1 attaches normally and the running Host is never replaced
// (`docs/strangler/rollback.md` §1). The rehearsal makes such a build of this tree, without changing what any other build
// contains:
//
// - `load` answers the contracts module `src/contracts/host-protocol/protocolVersion.ts` with the rehearsal's own
//   constant, so the UI-main and the Host bundles of that build agree on it, as one build's two processes do;
// - `config` sends every target's output under the rehearsal's own `out/` folder, mirroring the repository's `out/`
//   layout, and refuses a target whose output lies anywhere else;
// - where a config stamps `__DWARFAI_APP_VERSION__` (the Host's own version, electron.vite.host.config.ts), it stamps
//   the rehearsal's app version instead, so the Host says the version its copy is named after.
//
// Only `build-rehearsal-app.mjs` passes it, inline, to electron-vite's `build()`. No config file and no package script
// names it (rehearsalBuild.test.mjs), so the release build keeps the real PROTOCOL_VERSION.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The one module that holds PROTOCOL_VERSION (ADR-003 item 5). */
export const PROTOCOL_VERSION_MODULE = path.join(
  REPO_ROOT,
  'src',
  'contracts',
  'host-protocol',
  'protocolVersion.ts'
)

export const REHEARSAL_PLUGIN_NAME = 'dwarfai:rehearsal-build'

const REPO_OUT = path.join(REPO_ROOT, 'out')

/** The same file, whatever the separators or (on Windows) the case Vite hands it with. */
function sameFile(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** `X.Y.Z` → `X.Y.(Z+1)`: the rollback build's version, above the faulty build's (21 §2.1 item 1). */
export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) throw new Error(`not a plain X.Y.Z version: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

/**
 * @param {{ outRoot: string, protocolVersion: number, appVersion: string }} options
 *   `outRoot`: the rehearsal app folder; its build goes into `<outRoot>/out/`, laid out as the repository's `out/`.
 */
export function rehearsalBuildPlugin({ outRoot, protocolVersion, appVersion }) {
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new Error(`protocolVersion must be a positive integer, got ${protocolVersion}`)
  }
  return {
    name: REHEARSAL_PLUGIN_NAME,
    // After electron-vite's presets, which set the renderer and preload output folders.
    config: {
      order: 'post',
      handler(config) {
        const outDir = config.build?.outDir
        const resolved = path.resolve(REPO_ROOT, outDir ?? '')
        const relative = path.relative(REPO_OUT, resolved)
        if (outDir === undefined || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`a build target writes outside out/: ${String(outDir)}`)
        }
        const change = { build: { outDir: path.join(outRoot, 'out', relative) } }
        if (config.define?.__DWARFAI_APP_VERSION__ !== undefined) {
          change.define = { __DWARFAI_APP_VERSION__: JSON.stringify(appVersion) }
        }
        return change
      }
    },
    // Before Vite reads the file from disk.
    load: {
      order: 'pre',
      handler(id) {
        const file = id.split('?')[0]
        if (!sameFile(file, PROTOCOL_VERSION_MODULE)) return null
        return `export const PROTOCOL_VERSION = ${protocolVersion}\n`
      }
    }
  }
}
