// Absolute-path rules as each OS writes its paths, shared by the pure rules both processes run
// (endpoint.ts, versionedCopyRoot.ts). `contracts` imports no `node:*` module (R9), so the parts of
// `node:path` those rules need are written here once. Internal to contracts: not exported by
// index.ts.

/** The OSes the rules name (endpoint.ts `EndpointPlatform`; kept here so neither imports the other). */
type OsPlatform = 'win32' | 'darwin' | 'linux'

/** A drive or UNC path on Windows; a path from `/` elsewhere. */
export function isAbsolutePath(path: string, platform: OsPlatform): boolean {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path)
  return path.startsWith('/')
}

/**
 * Separators, `.` and `..` resolved, no trailing separator except a bare root (`/`, `C:\`).
 * Called only on an absolute path.
 */
export function normaliseAbsolutePath(path: string, platform: OsPlatform): string {
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
