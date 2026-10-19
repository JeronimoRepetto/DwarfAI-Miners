// The facts the Host feeds the ADR-002 D2 endpoint rule (`endpointFor` in contracts/host-protocol),
// read from this process and its OS. R18: the OS branching lives here, under host/platform; the
// rule itself is pure and takes the platform and the hash as values (lead decision 2026-09-30).
//
// - platform: this process's OS.
// - Windows: the user's SID, from `whoami /user` of System32 by path (as privilege.ts reads the
//   integrity label: never found on PATH, where Git for Windows ships another whoami). An
//   unreadable SID is a failed read with its cause, never a guessed value.
// - macOS: the home folder, and whether the volume holding `hostDataDir` ignores case. The probe
//   (S-030-1 is EPIC-05's spike; here only what the endpoint needs) stats the nearest existing
//   folder of `hostDataDir` whose name has a cased letter, and the same path with that name's case
//   swapped: the same file (device and inode) means a case-insensitive volume. Nothing to probe
//   means no folding (the S-030-1 fallback, 21 §9).
// - Linux: XDG_RUNTIME_DIR; Linux volumes are case-sensitive, so there is no probe.
// - sha256: Node's own, hex.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import type { EndpointInput, EndpointPlatform } from '@dwarfai/contracts'
import {
  parsed,
  windowsSystemTool,
  type QueryRunner,
  type ReadOutcome
} from '../process/probe/types'

/** A file's identity on its volume, or null when the path does not exist. */
export interface FileIdentity {
  dev: number
  ino: number
}

export interface NodeEndpointEnvOptions {
  /** DWARFAI_HOST_DATA_DIR, as AppPaths holds it. */
  hostDataDir: string
  /** Runs the Windows SID read; required on Windows (the composition root passes the bounded runner). */
  runQuery?: QueryRunner
  /** Which OS's facts to read; default this process's OS. */
  platform?: EndpointPlatform
  /** XDG_RUNTIME_DIR on Linux, SystemRoot on Windows; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  /** The user's home folder; default `os.homedir()`. */
  home?: string
  /** Stats a path for the macOS case probe; default `fs.stat`. */
  identityOf?: (path: string) => Promise<FileIdentity | null>
}

export type EndpointFacts = () => Promise<ReadOutcome<EndpointInput>>

/**
 * The bound on the SID read. The package names none; it is the bound privilege.ts gives the same
 * whoami program at the same boot (PRIVILEGE_QUERY_TIMEOUT_MS).
 */
export const USER_SID_QUERY_TIMEOUT_MS = 5_000

const USER_SID = /"(S-1-\d+(?:-\d+)+)"\s*$/m

export function createNodeEndpointFacts(options: NodeEndpointEnvOptions): EndpointFacts {
  const platform = options.platform ?? thisPlatform()
  const env = options.env ?? process.env
  const { hostDataDir } = options
  return async () => {
    if (platform === 'win32') {
      const runQuery = options.runQuery
      if (runQuery === undefined) return { ok: false, cause: 'has no query runner on Windows' }
      const sid = await readUserSid(runQuery, env)
      if (!sid.ok) return sid
      return { ok: true, value: { platform, hostDataDir, userSid: sid.value, sha256 } }
    }
    if (platform === 'darwin') {
      const identityOf = options.identityOf ?? statIdentity
      return {
        ok: true,
        value: {
          platform,
          hostDataDir,
          home: options.home ?? homedir(),
          caseInsensitiveVolume: await probeCaseInsensitive(hostDataDir, identityOf),
          sha256
        }
      }
    }
    const xdgRuntimeDir = env['XDG_RUNTIME_DIR']
    return {
      ok: true,
      value: {
        platform,
        hostDataDir,
        ...(xdgRuntimeDir === undefined ? {} : { xdgRuntimeDir }),
        sha256
      }
    }
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readUserSid(
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | undefined>>
): Promise<ReadOutcome<string>> {
  const out = await runQuery(windowsSystemTool('whoami.exe', env), ['/user', '/fo', 'csv', '/nh'], {
    timeoutMs: USER_SID_QUERY_TIMEOUT_MS
  })
  return parsed(out, (stdout) => USER_SID.exec(stdout)?.[1] ?? null)
}

async function probeCaseInsensitive(
  hostDataDir: string,
  identityOf: (path: string) => Promise<FileIdentity | null>
): Promise<boolean> {
  for (let path = hostDataDir; ; path = posix.dirname(path)) {
    const name = posix.basename(path)
    const swapped = swapCase(name)
    if (swapped !== name) {
      const original = await identityOf(path)
      if (original !== null) {
        const other = await identityOf(posix.join(posix.dirname(path), swapped))
        return other !== null && other.dev === original.dev && other.ino === original.ino
      }
    }
    if (posix.dirname(path) === path) return false
  }
}

function swapCase(name: string): string {
  return [...name]
    .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    .join('')
}

async function statIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const stats = await stat(path)
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

function thisPlatform(): EndpointPlatform {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
}
