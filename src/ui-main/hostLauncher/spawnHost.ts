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
import path from 'node:path'
import type { HostSpawnRequest } from './ports'

export interface HostSpawnInput {
  /** The app executable (hostSpawnInputFromCopy swaps in the versioned copy's, ISSUE-031). */
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

/**
 * The UI environment with a development checkout's `.env` entries under it, as `dotenv` layers them
 * (no override: a name the environment already has keeps its value, looked up as the environment
 * looks it up, so case-insensitively on Windows). UI main's legacy composition loads the same file
 * into its own environment, but only after the Host was started: the attach starts before Electron is
 * ready. The Host's other settings layer, the userData config file, is the Host's own read
 * (`host/wiring/routes/observation.ts` `readHostSettings`).
 */
export function withDotenvEntries(
  uiEnv: Readonly<Record<string, string | undefined>>,
  dotenv: Readonly<Record<string, string>>
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...uiEnv }
  for (const [name, value] of Object.entries(dotenv)) {
    if (uiEnv[name] === undefined) env[name] = value
  }
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

/**
 * The Host as it starts from its versioned copy (ADR-002 D5; SP-03): the executable, and the entry
 * when it is packaged inside the app directory (`resources/app.asar/out/host/main.js`), are taken
 * at the same relative place inside the copy. An entry outside the copied directory (a development
 * build's `out/host/main.js`) stays where it is and is run by the copied executable. An executable
 * outside the copied directory is refused: the Host never runs from the install folder (ADR-027
 * item 1).
 */
export function hostSpawnInputFromCopy(
  input: HostSpawnInput,
  copy: { sourceDir: string; contentDir: string }
): { ok: true; value: HostSpawnInput } | { ok: false; errCode: string } {
  const execPath = relocate(input.execPath, copy)
  if (execPath === null) return { ok: false, errCode: 'EXEC_OUTSIDE_COPY' }
  return {
    ok: true,
    value: { ...input, execPath, hostEntry: relocate(input.hostEntry, copy) ?? input.hostEntry }
  }
}

/** `file`'s place inside the copy, or null when it is not inside the copied directory. */
function relocate(file: string, copy: { sourceDir: string; contentDir: string }): string | null {
  const paths = WINDOWS_PATH.test(copy.sourceDir) ? path.win32 : path.posix
  const relative = paths.relative(copy.sourceDir, file)
  if (relative === '' || relative.startsWith('..') || paths.isAbsolute(relative)) return null
  return paths.join(copy.contentDir, relative)
}

/** A drive-letter or UNC path: the copy's paths follow the platform that wrote them. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/
