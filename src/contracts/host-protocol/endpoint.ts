// The Host's well-known UI endpoint (ADR-002 D2, AM-17-01; 09 §1 row "Host endpoint"): one pure rule
// that the Host (bind, ISSUE-022) and the UI (HostClient, EPIC-04; launcher, ISSUE-030) both run,
// so both always name the same endpoint for the same `hostDataDir`. `contracts` may not import
// `node:crypto` (R9): each process passes its own `sha256` and platform from an adapter (lead
// decision 2026-09-30, ISSUE-022).
//
// - profileKey = hex(sha256(canonical(hostDataDir)))[0..12]; canonical = the absolute path with
//   the OS's separators, `.` and `..` resolved, no trailing separator, case-folded on Windows and
//   on a case-insensitive macOS volume.
// - Windows: `\\.\pipe\dwarfai-host-<sha256(userSid)[0..16]>-<profileKey>` (the pipe namespace is
//   machine-wide, so the user is part of the name).
// - macOS: `~/Library/Application Support/<app>/run/host-<profileKey>.sock`. `<app>` is the
//   folder that holds `hostDataDir` (Electron's `userData`, whose last segment is the app's name:
//   `DwarfAI-Miners`, or `DwarfAI-dev` for a dev build).
// - Linux: `$XDG_RUNTIME_DIR/dwarfai/host-<profileKey>.sock`; without an absolute XDG_RUNTIME_DIR,
//   `<hostDataDir>/run/host-<profileKey>.sock`.
// - A socket path must fit `sockaddr_un.sun_path` with its terminating NUL (104 bytes on macOS,
//   108 on Linux); a longer one fails fast with a typed error (FM-037).

export type EndpointPlatform = 'win32' | 'darwin' | 'linux'

/** Lower-case hex SHA-256 of the UTF-8 text, supplied by the calling process. */
export type Sha256Hex = (text: string) => string

export type HostEndpoint =
  | { kind: 'named-pipe'; path: string }
  /** `dir` is the socket's run directory, created `0700` by the Host (ADR-003 item 1). */
  | { kind: 'unix-socket'; path: string; dir: string }

export type EndpointError =
  /** Not an absolute path, or one with no parent folder to name the run directory after. */
  | { kind: 'host-data-dir-invalid' }
  | { kind: 'user-sid-missing' }
  | { kind: 'home-missing' }
  | { kind: 'socket-path-too-long'; bytes: number; limit: number }

export type EndpointResult<T> = { ok: true; value: T } | { ok: false; error: EndpointError }

export interface EndpointInput {
  platform: EndpointPlatform
  /** `DWARFAI_HOST_DATA_DIR` on the Host; `userData` + `/host` on the UI. */
  hostDataDir: string
  /** The OS user's SID, string form (Windows). */
  userSid?: string
  /** `$XDG_RUNTIME_DIR` (Linux). */
  xdgRuntimeDir?: string
  /** The user's home folder (macOS). */
  home?: string
  /** Whether the volume holding `hostDataDir` ignores case (macOS; S-030-1 fallback: false). */
  caseInsensitiveVolume?: boolean
  sha256: Sha256Hex
}

/** `sockaddr_un.sun_path` sizes, the terminating NUL included. */
const SUN_PATH_BYTES: Readonly<Record<Exclude<EndpointPlatform, 'win32'>, number>> = {
  darwin: 104,
  linux: 108
}

const PROFILE_KEY_LENGTH = 12
const USER_KEY_LENGTH = 16

/**
 * `path` normalised as one OS writes it: its separators, `.` and `..` resolved, runs of separators
 * collapsed and no trailing separator; case-folded when `caseInsensitive`. A Windows UNC prefix
 * (`\\server`) keeps its two leading separators.
 */
export function canonicalHostDataDir(
  path: string,
  options: { platform: EndpointPlatform; caseInsensitive: boolean }
): string {
  const normalised = normalisePath(path, options.platform)
  return options.caseInsensitive ? normalised.toLowerCase() : normalised
}

export function profileKey(canonical: string, sha256: Sha256Hex): string {
  return sha256(canonical).slice(0, PROFILE_KEY_LENGTH)
}

/** ADR-002 D2: a socket path must fit `sun_path` with its NUL; a named pipe has no such limit. */
export function checkSocketPathLength(
  platform: EndpointPlatform,
  path: string
): EndpointResult<void> {
  if (platform === 'win32') return { ok: true, value: undefined }
  const limit = SUN_PATH_BYTES[platform]
  const bytes = new TextEncoder().encode(path).length
  return bytes < limit
    ? { ok: true, value: undefined }
    : { ok: false, error: { kind: 'socket-path-too-long', bytes, limit } }
}

export function endpointFor(input: EndpointInput): EndpointResult<HostEndpoint> {
  const { platform, sha256 } = input
  if (!isAbsolute(input.hostDataDir, platform)) return invalid()
  const dataDir = normalisePath(input.hostDataDir, platform)
  const caseInsensitive =
    platform === 'win32' || (platform === 'darwin' && input.caseInsensitiveVolume === true)
  const key = profileKey(canonicalHostDataDir(dataDir, { platform, caseInsensitive }), sha256)

  if (platform === 'win32') {
    if (input.userSid === undefined || input.userSid === '') {
      return { ok: false, error: { kind: 'user-sid-missing' } }
    }
    const user = sha256(input.userSid).slice(0, USER_KEY_LENGTH)
    return {
      ok: true,
      value: { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-host-${user}-${key}` }
    }
  }

  let dir: string
  if (platform === 'darwin') {
    if (input.home === undefined || !isAbsolute(input.home, platform)) {
      return { ok: false, error: { kind: 'home-missing' } }
    }
    const app = parentName(dataDir)
    if (app === '') return invalid()
    dir = under(normalisePath(input.home, platform), `Library/Application Support/${app}/run`)
  } else {
    const xdg = input.xdgRuntimeDir
    dir =
      xdg !== undefined && isAbsolute(xdg, platform)
        ? under(normalisePath(xdg, platform), 'dwarfai')
        : under(dataDir, 'run')
  }
  const path = `${dir}/host-${key}.sock`
  const length = checkSocketPathLength(platform, path)
  if (!length.ok) return length
  return { ok: true, value: { kind: 'unix-socket', path, dir } }
}

function invalid(): EndpointResult<never> {
  return { ok: false, error: { kind: 'host-data-dir-invalid' } }
}

function isAbsolute(path: string, platform: EndpointPlatform): boolean {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path)
  return path.startsWith('/')
}

/**
 * Separators, `.` and `..` resolved, no trailing separator except a bare root (`/`, `C:\`).
 * Called only on an absolute path.
 */
function normalisePath(path: string, platform: EndpointPlatform): string {
  const sep = platform === 'win32' ? '\\' : '/'
  const unified = platform === 'win32' ? path.replace(/\//g, '\\') : path
  let root: string
  let rest: string
  if (platform === 'win32' && unified.startsWith('\\\\')) {
    root = '\\\\'
    rest = unified.slice(2)
  } else if (platform === 'win32' && /^[A-Za-z]:/.test(unified)) {
    root = `${unified.slice(0, 2)}\\`
    rest = unified.slice(2)
  } else {
    root = sep
    rest = unified
  }
  const segments: string[] = []
  for (const segment of rest.split(sep)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return root + segments.join(sep)
}

/** `relative` inside the normalised POSIX folder `base` (which ends in `/` only when it is `/`). */
function under(base: string, relative: string): string {
  return `${base === '/' ? '' : base}/${relative}`
}

/** The name of the folder that holds `path` ('' when `path` sits at the root). */
function parentName(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '')
  return segments.length >= 2 ? (segments[segments.length - 2] ?? '') : ''
}
