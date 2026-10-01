// The directory the Host's versioned copy is made from (ADR-002 D5; SP-03 decision table). Node
// built-ins only and erasable TypeScript only, so scripts/build/write-host-manifest.mjs imports it as
// it is (Node 24 strips the types) and names the same directory the launcher copies.
import path from 'node:path'

export type CopyPlatform = 'win32' | 'darwin' | 'linux'

/**
 * The directory the copy is made from: the one holding the executable and its `resources`
 * (ADR-002 D5), or on macOS the `.app` bundle the executable sits in (`<Name>.app/Contents/MacOS/`),
 * whose `Contents/Resources` and `Contents/Frameworks` the Host needs too (SP-03).
 */
export function copySourceOf(execPath: string, platform: CopyPlatform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const folder = paths.dirname(execPath)
  if (platform === 'darwin') {
    const contents = paths.dirname(folder)
    const bundle = paths.dirname(contents)
    if (
      paths.basename(folder) === 'MacOS' &&
      paths.basename(contents) === 'Contents' &&
      bundle.endsWith('.app')
    ) {
      return bundle
    }
  }
  return folder
}
