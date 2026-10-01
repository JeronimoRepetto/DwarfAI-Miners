// What the launcher starts (ADR-002 D1, D2; 02 NFR-SEC-05): the app's own executable with the
// Host entry as its one argument, `ELECTRON_RUN_AS_NODE=1`, and `DWARFAI_HOST_DATA_DIR`.
//
// - argv is the entry path alone: no token, no secret, no data folder (NFR-SEC-05).
// - The environment is the UI's own, which the Host inherits as any child would (it needs PATH,
//   the home and profile folders, XDG_RUNTIME_DIR for its endpoint, and the provider settings the
//   person started the app with, 19 §11 row 10), with every `DWARFAI_*` name removed: the
//   launcher alone sets those. It then adds the minimal set: `ELECTRON_RUN_AS_NODE=1`,
//   `DWARFAI_HOST_DATA_DIR`, and `DWARFAI_LOG` when the UI has it (19 §6: the Host inherits the
//   level). A DwarfAI token found in the UI's environment (a legacy delegation token, say) never
//   reaches the Host.
// - The working folder is `hostDataDir`, which the Host owns, never the UI's working folder.
// - The environment is always passed whole and explicitly: on Windows the Host is created by a
//   launcher step or by WMI, which does not inherit the UI's environment (windows.ts).
import type { HostSpawnRequest } from './ports'

export interface HostSpawnInput {
  /** The app executable (later: ISSUE-031 swaps in the versioned copy's). */
  execPath: string
  /** The Host entry script (`out/host/main.js`). */
  hostEntry: string
  /** `<userData>/host` (ADR-002 D2). */
  hostDataDir: string
  /** The UI process's own environment. */
  uiEnv: Readonly<Record<string, string | undefined>>
}

/** The names the launcher owns; compared ignoring case, as Windows compares names. */
const DWARFAI_PREFIX = 'DWARFAI_'

export function hostEnvironment(
  uiEnv: Readonly<Record<string, string | undefined>>,
  hostDataDir: string
): Record<string, string> {
  const env: Record<string, string> = {}
  let logLevel: string | undefined
  for (const [name, value] of Object.entries(uiEnv)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (upper === 'DWARFAI_LOG') logLevel = value
    if (upper.startsWith(DWARFAI_PREFIX) || upper === 'ELECTRON_RUN_AS_NODE') continue
    env[name] = value
  }
  env['ELECTRON_RUN_AS_NODE'] = '1'
  env['DWARFAI_HOST_DATA_DIR'] = hostDataDir
  if (logLevel !== undefined) env['DWARFAI_LOG'] = logLevel
  return env
}

export function buildHostSpawn(input: HostSpawnInput): HostSpawnRequest {
  return {
    file: input.execPath,
    args: [input.hostEntry],
    env: hostEnvironment(input.uiEnv, input.hostDataDir),
    cwd: input.hostDataDir
  }
}
