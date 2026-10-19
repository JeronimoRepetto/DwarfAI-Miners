// The UI's side of the ADR-002 D2 endpoint rule (AM-17-01): the facts `endpointFor` (contracts)
// needs, read the way the Host reads them (src/host/platform/endpoint/nodeEndpointEnv.ts,
// ISSUE-022), so both name the same endpoint for the same `hostDataDir`. Restated because the UI
// tree may not import the Host (R10); a difference here would leave the UI knocking on another
// endpoint than the Host's, so each rule below is the Host's rule word for word.
//
// - Windows: the user's SID from `whoami /user /fo csv /nh` of System32 by path (never PATH, where
//   Git for Windows ships another whoami). An unreadable SID is `user-sid-missing`, never a guess.
// - macOS: the home folder, and whether the volume holding `hostDataDir` ignores case: stat the
//   nearest existing folder of `hostDataDir` whose name has a cased letter and the same path with
//   that name's case swapped; the same file (device and inode) means a case-insensitive volume.
// - Linux: XDG_RUNTIME_DIR (volumes are case-sensitive, no probe).
// - sha256: Node's own, hex.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { endpointFor, type EndpointResult, type HostEndpoint } from '@dwarfai/contracts'
import type { QueryRunner } from './processStart'

/** The bound on the SID read: the Host's USER_SID_QUERY_TIMEOUT_MS. */
export const USER_SID_QUERY_TIMEOUT_MS = 5_000

const USER_SID = /"(S-1-\d+(?:-\d+)+)"\s*$/m

export interface FileIdentity {
  dev: number
  ino: number
}

export interface UiEndpointOptions {
  platform: 'win32' | 'darwin' | 'linux'
  /** `<userData>/host`. */
  hostDataDir: string
  /** XDG_RUNTIME_DIR on Linux, SystemRoot on Windows. */
  env: Readonly<Record<string, string | undefined>>
  /** Runs the Windows SID read; required on Windows. */
  runQuery?: QueryRunner
  /** The user's home folder; default `os.homedir()`. */
  home?: string
  /** Stats a path for the macOS case probe; default `fs.stat`. */
  identityOf?: (path: string) => Promise<FileIdentity | null>
}

export async function resolveUiEndpoint(
  options: UiEndpointOptions
): Promise<EndpointResult<HostEndpoint>> {
  const { platform, hostDataDir, env } = options
  if (platform === 'win32') {
    const userSid = options.runQuery === undefined ? null : await readUserSid(options.runQuery, env)
    if (userSid === null) return { ok: false, error: { kind: 'user-sid-missing' } }
    return endpointFor({ platform, hostDataDir, userSid, sha256 })
  }
  if (platform === 'darwin') {
    return endpointFor({
      platform,
      hostDataDir,
      home: options.home ?? homedir(),
      caseInsensitiveVolume: await probeCaseInsensitive(
        hostDataDir,
        options.identityOf ?? statIdentity
      ),
      sha256
    })
  }
  const xdgRuntimeDir = env['XDG_RUNTIME_DIR']
  return endpointFor({
    platform,
    hostDataDir,
    ...(xdgRuntimeDir === undefined ? {} : { xdgRuntimeDir }),
    sha256
  })
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readUserSid(
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | undefined>>
): Promise<string | null> {
  const root = (env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows').replace(/[\\/]+$/, '')
  const out = await runQuery(`${root}\\System32\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], {
    timeoutMs: USER_SID_QUERY_TIMEOUT_MS
  })
  return out.ok ? (USER_SID.exec(out.stdout)?.[1] ?? null) : null
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
