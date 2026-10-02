// The real DwarfAI Host of this checkout for OS-lane tests (17 §1.8, §1.6 "the same suite over a real pipe or
// socket"): `buildRealHost` builds `out/host/main.js` (electron.vite.host.config.ts, the build `pnpm build` makes
// too), and `startRealHost` runs it the way the launcher does, on the installed Electron binary with
// ELECTRON_RUN_AS_NODE=1 and DWARFAI_HOST_DATA_DIR (ADR-002 D1, D4), here as a plain child of the test so the test
// can end it. Never imported by production code (R14); it lives under hostLauncher/ because that is the one UI path
// allowed to start a process (R17). Every Host it starts runs in an isolated environment (realHostEnv.ts) with a
// home of its own, removed once the Host exited, so its start-up CLI detection (ADR-009 D5) finds no real provider CLI.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'electron-vite'
import { isolatedHostEnv } from './realHostEnv'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
/** The Electron binary of the installed `electron` package (its main export is the path). */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
/** The Host's run files appear within this bound of its start (ADR-002 D4's 15 s readiness budget). */
const READY_BUDGET_MS = 15_000

/** Builds the Host into `out/host/main.js` and answers its path. */
export async function buildRealHost(): Promise<string> {
  await build({
    root: REPO_ROOT,
    configFile: path.join(REPO_ROOT, 'electron.vite.host.config.ts'),
    logLevel: 'warn'
  })
  return path.join(REPO_ROOT, 'out', 'host', 'main.js')
}

export interface RealHost {
  readonly pid: number
  /** Whether the process still runs. */
  readonly alive: boolean
  /** Settles with the exit code once the process exited. */
  readonly exited: Promise<number | null>
  /** Ends the process (a crash, for the client: no `host.closing`) and waits for its exit. */
  kill(): Promise<void>
}

/**
 * Starts the Host with `hostDataDir` and the environment overrides `env` (HOME, XDG_RUNTIME_DIR on POSIX), and
 * resolves once `run/host.identity` names its pid, which the Host writes right after its endpoint is bound (ADR-002
 * D3; a killed Host's file stays behind, so the pid tells the new one's apart).
 */
export async function startRealHost(options: {
  entry: string
  hostDataDir: string
  env?: Readonly<Record<string, string>>
}): Promise<RealHost> {
  const home = mkdtempSync(path.join(tmpdir(), 'dwarfai-host-home-'))
  const child = spawn(ELECTRON, [options.entry], {
    env: {
      ...isolatedHostEnv({
        base: process.env,
        home,
        platform: process.platform,
        ...(options.env === undefined ? {} : { overrides: options.env })
      }),
      ELECTRON_RUN_AS_NODE: '1',
      DWARFAI_HOST_DATA_DIR: options.hostDataDir
    },
    stdio: 'ignore',
    windowsHide: true,
    shell: false
  })
  const exited = new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode)
    else child.once('exit', (code) => resolve(code))
  }).then((code) => {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // A file the OS still holds: the temp folder is left to the OS cleanup, never the test's failure.
    }
    return code
  })
  child.once('error', () => {})
  const host: RealHost = {
    pid: child.pid ?? -1,
    get alive() {
      return child.exitCode === null && child.signalCode === null
    },
    exited,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGKILL')
      await exited
    }
  }
  const identity = path.join(options.hostDataDir, 'run', 'host.identity')
  const deadline = Date.now() + READY_BUDGET_MS
  let gone = false
  void exited.then(() => (gone = true))
  while (identityPid(identity) !== host.pid) {
    if (gone || Date.now() > deadline) {
      await host.kill()
      throw new Error(`the Host did not come up (exit ${String(child.exitCode)})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return host
}

/** The pid `run/host.identity` names, or null while there is none. */
function identityPid(file: string): number | null {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid ?? null
  } catch {
    return null
  }
}
